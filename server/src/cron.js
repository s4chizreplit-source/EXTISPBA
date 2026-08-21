/**
 * Organic run dispatcher — runs every 15 seconds.
 *
 * Flow for each run:
 *   1. Lock pending runs → mark 'started'
 *   2. Call provider `action=add` → get provider order ID
 *   3. Mark run as 'processing' (NOT completed yet — order placed, not delivered)
 *   4. Separate status-check loop polls `action=status` every tick
 *   5. When provider reports "Completed" → mark run 'completed'
 *
 * Provider rotation:
 *   For each run, try providers in sort_order (priority 1 first).
 *   If a provider rejects "active order with this link" → try the next.
 *   If ALL providers are busy with that link → reset run back to
 *   pending (scheduled_at = now, NO retry_count increment) so the
 *   very next tick checks again once a slot opens up.
 *   Any other error (timeout, API error, bad response) → retry_count++,
 *   and back to pending with a 5-min delay (or failed after 3 strikes).
 */

import { query, withTx } from './db.js';
import { getEnvProvider, isValidProviderApiUrl } from './provider-config.js';
import { areEngagementOrderWritesReady } from './seeds/historicalOrderSeed.js';
import {
  getProviderOrderQuantity,
  isProviderMinimumQuantityError,
  normalizeProviderMinimum,
} from './provider.js';

const BATCH_SIZE        = 25;
const TICK_MS           = 15_000;
const STATUS_BATCH_SIZE = 50;   // how many 'processing' runs to status-check per tick
const MIN_LIVE_ORDER_NUMBER = 3800;
const ENV_PROVIDER      = getEnvProvider();
const ENV_PROVIDER_URL  = ENV_PROVIDER?.api_url || '';
const ENV_PROVIDER_KEY  = ENV_PROVIDER?.api_key || '';
const ENV_PROVIDER_NAME = String(process.env.PROVIDER_NAME || 'Primary Provider').trim();
const HAS_ENV_PROVIDER  = Boolean(ENV_PROVIDER);

/** True when the provider error means "same link is already active". */
function isActiveLinkError(msg = '') {
  const m = msg.toLowerCase();
  return (
    m.includes('active order with this link') ||
    m.includes('already have an active order') ||
    m.includes('order with same link')
  );
}

export function getProviderQuantityDecision({ quantityToSend, deliveryMultiplier, providerMinimum }) {
  const sendQty = getProviderOrderQuantity(quantityToSend, deliveryMultiplier);
  const minimum = normalizeProviderMinimum(providerMinimum);
  return { sendQty, minimum, meetsMinimum: sendQty >= minimum };
}

export function getDispatchFallback({ minimumProblemCount, busyProviderCount, lastError }) {
  if (lastError) return 'retry';
  if (busyProviderCount > 0) return 'wait';
  if (minimumProblemCount > 0) return 'minimum';
  return 'retry';
}

/** Low-level HTTP call to one SMM panel account. */
async function callAccount({ api_url, api_key }, params, timeoutMs = 20_000) {
  if (!isValidProviderApiUrl(api_url)) {
    throw new Error('Provider API URL is not a valid HTTP(S) endpoint');
  }
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ key: api_key, ...params });
    const res  = await fetch(api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    const data = JSON.parse(text);
    if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ── Dispatch pending runs ─────────────────────────────────────────────────────

async function processBatch() {
  const runs = await withTx(async (client) => {
    // Step 1 — lock BATCH_SIZE distinct pending run rows (no JOIN fan-out).
    const { rows: locked } = await client.query(`
      SELECT ors.id
        FROM organic_run_schedule ors
        JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
        JOIN engagement_orders      eo  ON eo.id  = eoi.engagement_order_id
       WHERE ors.status = 'pending'
         AND ors.retry_count < 3
         AND ors.scheduled_at <= now()
          AND eo.order_number >= $2
         AND eo.status  NOT IN ('cancelled','paused','completed')
         AND eoi.status NOT IN ('cancelled','paused','completed','failed')
       ORDER BY ors.scheduled_at ASC
       LIMIT $1
       FOR UPDATE OF ors SKIP LOCKED
    `, [BATCH_SIZE, MIN_LIVE_ORDER_NUMBER]);

    if (locked.length === 0) return [];
    const ids = locked.map(r => r.id);

    // Step 2 — mark 'started' so other ticks never re-pick these rows.
    await client.query(
      `UPDATE organic_run_schedule SET status='started', started_at=now() WHERE id = ANY($1)`,
      [ids]
    );

    // Step 3 — fetch full details + ALL provider accounts ordered by priority.
    const { rows } = await client.query(`
      SELECT
        ors.id,
        ors.quantity_to_send,
        ors.engagement_order_item_id,
        ors.retry_count,
        eo.link,
        eo.id                                                     AS order_id,
         COALESCE(s.min_quantity, 1)                               AS provider_minimum,
        COALESCE(spm.provider_service_id, s.provider_service_id)  AS provider_service_id,
        COALESCE(spm.sort_order, 999)                             AS sort_order,
        pa.id                                                     AS account_id,
        pa.name                                                   AS account_name,
        pa.api_url,
        pa.api_key,
        COALESCE(pa.delivery_multiplier, 1)                       AS delivery_multiplier
      FROM organic_run_schedule ors
      JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
      JOIN engagement_orders      eo  ON eo.id  = eoi.engagement_order_id
      LEFT JOIN services s            ON s.id   = eoi.service_id
      LEFT JOIN service_provider_mapping spm
             ON spm.service_id = s.id AND spm.is_active = true
      LEFT JOIN provider_accounts pa
              ON pa.id = spm.provider_account_id
             AND pa.is_active = true
             AND NULLIF(TRIM(pa.api_key), '') IS NOT NULL
             AND NULLIF(TRIM(pa.api_url), '') IS NOT NULL
      WHERE ors.id = ANY($1)
      ORDER BY ors.id, COALESCE(spm.sort_order, 999) ASC
    `, [ids]);

    // Group rows by run id → { runId: { meta, providers[] } }
    const byRun = new Map();
    for (const row of rows) {
      if (!byRun.has(row.id)) {
        byRun.set(row.id, {
          id:                        row.id,
          quantity_to_send:          row.quantity_to_send,
          engagement_order_item_id:  row.engagement_order_item_id,
          retry_count:               row.retry_count,
          link:                      row.link,
          order_id:                  row.order_id,
           provider_minimum:          row.provider_minimum,
          provider_service_id:       row.provider_service_id,
          providers: [],
        });
      }
      if (row.account_id && row.api_url && row.api_key && row.provider_service_id) {
        byRun.get(row.id).providers.push({
          account_id:          row.account_id,
          account_name:        row.account_name,
          api_url:             row.api_url,
          api_key:             row.api_key,
          provider_service_id: row.provider_service_id,
          delivery_multiplier: Number(row.delivery_multiplier ?? 1),
        });
      }
    }

    if (HAS_ENV_PROVIDER) {
      for (const run of byRun.values()) {
        if (run.providers.length === 0 && run.provider_service_id) {
          run.providers.push({
            account_id: null,
            account_name: ENV_PROVIDER_NAME,
            api_url: ENV_PROVIDER_URL,
            api_key: ENV_PROVIDER_KEY,
            provider_service_id: run.provider_service_id,
            delivery_multiplier: 1,
          });
        }
      }
    }

    return Array.from(byRun.values());
  });

  if (runs.length === 0) return;
  console.log(`[cron] Processing ${runs.length} overdue run(s)`);
  await Promise.allSettled(runs.map(run => dispatchRun(run)));
}

async function dispatchRun(run) {
  const { providers } = run;

  // ── No providers configured → wait; never fake a completed delivery ─────
  if (providers.length === 0) {
    await query(
      `UPDATE organic_run_schedule
          SET status='pending',
              started_at=NULL,
              scheduled_at=now() + interval '5 minutes',
              error_message='Waiting for an active provider account and service mapping'
        WHERE id=$1`,
      [run.id]
    );
    console.warn(`[cron] ⚠ Run ${run.id} waiting: no active provider mapping/account`);
    return;
  }

  // ── Try providers in priority order ─────────────────────────────────────
  const minimumProblems = [];
  let busyProviderCount = 0;
  let lastErr = null;

  for (const prov of providers) {
    const quantity = getProviderQuantityDecision({
      quantityToSend: run.quantity_to_send,
      deliveryMultiplier: prov.delivery_multiplier,
      providerMinimum: run.provider_minimum,
    });
    if (!quantity.meetsMinimum) {
      const problem = `Provider minimum is ${quantity.minimum}; scheduled batch sends ${quantity.sendQty}`;
      minimumProblems.push(problem);
      console.warn(`[cron] ⏸ Run ${run.id} not sent: ${problem}`);
      continue;
    }

    try {
      const data = await callAccount(prov, {
        action:   'add',
        service:  String(prov.provider_service_id),
        link:     run.link,
        quantity: String(quantity.sendQty),
      });

      const providerOrderId = String(data.order ?? data.id ?? '');
      if (!providerOrderId) throw new Error('Provider returned no order id');

      // ✅ Order placed — mark as 'processing', NOT completed yet
      // Real completion is confirmed by the status-check loop below.
      await query(
        `UPDATE organic_run_schedule
            SET status='processing',
                started_at=now(),
                provider_order_id=$1,
                provider_response=$2,
                provider_account_id=$3,
                provider_account_name=$4,
                last_status_check=now()
          WHERE id=$5`,
        [
          providerOrderId,
          JSON.stringify({ order: providerOrderId }),
          prov.account_id,
          prov.account_name || ENV_PROVIDER_NAME,
          run.id,
        ]
      );
      if (prov.account_id) {
        query(`UPDATE provider_accounts SET last_used_at=now() WHERE id=$1`, [prov.account_id]).catch(() => {});
      }
      console.log(`[cron] 📤 Run ${run.id} → provider order ${providerOrderId} (processing)`);
      return;

    } catch (err) {
      if (isActiveLinkError(err.message)) {
        busyProviderCount += 1;
        const providerLabel = String(prov.account_id || prov.account_name || 'provider').slice(0, 16);
        console.log(`[cron] ↩ Run ${run.id}: provider busy (${providerLabel}…), trying next`);
        continue;
      }
      if (isProviderMinimumQuantityError(err)) {
        minimumProblems.push(String(err.message).slice(0, 500));
        console.warn(`[cron] ⏸ Run ${run.id} rejected for provider minimum; trying next provider`);
        continue;
      }
      lastErr  = err;
      break;
    }
  }

  const fallback = getDispatchFallback({
    minimumProblemCount: minimumProblems.length,
    busyProviderCount,
    lastError: lastErr,
  });

  // A minimum error is deterministic. Try another mapped provider first; if none
  // can accept it, merge this amount into a pending sibling or hold it for a
  // provider/configuration change. Never spend the retry budget on this case.
  if (fallback === 'minimum') {
    const minimumProblem = minimumProblems.at(-1);
    const result = await mergeOrHoldUndersizedRun(run, minimumProblem);
    console.warn(`[cron] ⏸ Run ${run.id} ${result}: ${minimumProblem} (no retry_count change)`);
    return;
  }

  // ── All providers busy with this link → re-queue without penalty ─────────
  if (fallback === 'wait') {
    await query(
      `UPDATE organic_run_schedule
          SET status='pending',
              scheduled_at=now(),
              error_message='All providers busy with this link — waiting for a slot'
        WHERE id=$1`,
      [run.id]
    );
    console.log(`[cron] ⏳ Run ${run.id}: all providers busy — requeued (no retry_count change)`);
    return;
  }

  // ── Real failure → increment retry_count ─────────────────────────────────
  const retryCount = (run.retry_count ?? 0) + 1;
  const newStatus  = retryCount >= 3 ? 'failed' : 'pending';
  await query(
    `UPDATE organic_run_schedule
        SET status=$1,
            error_message=$2,
            retry_count=$3,
            scheduled_at=${newStatus === 'pending' ? `now() + interval '5 minutes'` : 'scheduled_at'},
            completed_at=${newStatus === 'failed'  ? 'now()' : 'NULL'}
      WHERE id=$4`,
    [newStatus, lastErr?.message?.slice(0, 500), retryCount, run.id]
  );
  console.warn(`[cron] ❌ Run ${run.id} failed (attempt ${retryCount}): ${lastErr?.message}`);
}

async function mergeOrHoldUndersizedRun(run, reason) {
  return withTx(async (client) => {
    // Historical orders are deliberately excluded even if this helper is called
    // directly in the future; they remain display-only records.
    const { rows: siblings } = await client.query(
      `SELECT candidate.id
         FROM organic_run_schedule candidate
         JOIN engagement_order_items eoi ON eoi.id = candidate.engagement_order_item_id
         JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
        WHERE candidate.engagement_order_item_id = $1
          AND candidate.id <> $2
          AND candidate.status = 'pending'
          AND eo.order_number >= $3
        ORDER BY candidate.scheduled_at ASC
        LIMIT 1
        FOR UPDATE OF candidate`,
      [run.engagement_order_item_id, run.id, MIN_LIVE_ORDER_NUMBER]
    );

    if (siblings[0]) {
      const quantity = Math.max(0, Number(run.quantity_to_send) || 0);
      const merged = await client.query(
        `UPDATE organic_run_schedule current
            SET status = 'cancelled',
                quantity_to_send = 0,
                base_quantity = 0,
                started_at = NULL,
                completed_at = now(),
                error_message = $1
           FROM engagement_order_items eoi
           JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
          WHERE current.id = $2
            AND eoi.id = current.engagement_order_item_id
            AND eo.order_number >= $3
            AND current.status = 'started'
        RETURNING current.id`,
        [`Merged into run ${siblings[0].id} (${quantity} moved): ${reason}`, run.id, MIN_LIVE_ORDER_NUMBER]
      );
      if (merged.rows[0]) {
        await client.query(
          `UPDATE organic_run_schedule
              SET quantity_to_send = quantity_to_send + $1,
                  base_quantity = base_quantity + $1
            WHERE id = $2`,
          [quantity, siblings[0].id]
        );
        return `merged into sibling run ${siblings[0].id}`;
      }
    }

    await client.query(
      `UPDATE organic_run_schedule current
          SET status = 'held',
              started_at = NULL,
              error_message = $1
         FROM engagement_order_items eoi
         JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
        WHERE current.id = $2
          AND eoi.id = current.engagement_order_item_id
          AND eo.order_number >= $3
          AND current.status = 'started'`,
      [`Held: ${reason}. Add a compatible provider or reschedule this amount.`, run.id, MIN_LIVE_ORDER_NUMBER]
    );
    return 'held for compatible provider or manual rescheduling';
  });
}

async function recoverSimulatedRuns() {
  return withTx(async (client) => {
    const { rows } = await client.query(`
      SELECT ors.id, eoi.id AS item_id, eo.id AS order_id
        FROM organic_run_schedule ors
        JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
        JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
       WHERE ors.status = 'completed'
         AND ors.provider_order_id LIKE 'sim_%'
          AND eo.order_number >= $1
       FOR UPDATE OF ors
    `, [MIN_LIVE_ORDER_NUMBER]);
    if (rows.length === 0) return 0;

    const runIds = rows.map(row => row.id);
    const itemIds = [...new Set(rows.map(row => row.item_id))];
    const orderIds = [...new Set(rows.map(row => row.order_id))];

    await client.query(
      `UPDATE organic_run_schedule
          SET status='pending',
              started_at=NULL,
              completed_at=NULL,
              provider_order_id=NULL,
              provider_response=NULL,
              provider_account_id=NULL,
              provider_account_name=NULL,
              provider_status=NULL,
              last_status_check=NULL,
              error_message='Recovered simulated run — waiting for real provider dispatch',
              scheduled_at=LEAST(scheduled_at, now())
        WHERE id = ANY($1::uuid[])`,
      [runIds]
    );
    await client.query(
      `UPDATE engagement_order_items
          SET status='pending'
        WHERE id = ANY($1::uuid[])
          AND status='completed'`,
      [itemIds]
    );
    await client.query(
      `UPDATE engagement_orders
          SET status='processing', updated_at=now()
        WHERE id = ANY($1::uuid[])
          AND status='completed'`,
      [orderIds]
    );
    return rows.length;
  });
}

// ── Status-check loop: poll provider for 'processing' runs ───────────────────

async function checkProcessingRuns() {
  // Fetch runs in 'processing' state that haven't been checked in the last 30s
  const { rows: runs } = await query(`
    SELECT
      ors.id,
      ors.provider_order_id,
      ors.quantity_to_send,
      ors.engagement_order_item_id,
      ors.provider_account_name AS saved_account_name,
      pa.id       AS account_id,
      pa.api_url,
      pa.api_key,
      pa.name     AS account_name,
      COALESCE(pa.delivery_multiplier, 1) AS delivery_multiplier
    FROM organic_run_schedule ors
    JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
    JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
    LEFT JOIN provider_accounts pa ON pa.id = ors.provider_account_id
    WHERE ors.status = 'processing'
      AND ors.provider_order_id IS NOT NULL
      AND eo.order_number >= $3
      AND (
        (
          pa.is_active = true
          AND NULLIF(TRIM(pa.api_key), '') IS NOT NULL
          AND NULLIF(TRIM(pa.api_url), '') IS NOT NULL
        )
        OR (ors.provider_account_id IS NULL AND $2::boolean)
      )
      AND (ors.last_status_check IS NULL OR ors.last_status_check < now() - interval '30 seconds')
    ORDER BY ors.last_status_check ASC NULLS FIRST
    LIMIT $1
  `, [STATUS_BATCH_SIZE, HAS_ENV_PROVIDER, MIN_LIVE_ORDER_NUMBER]);

  if (runs.length === 0) return;

  // Group by provider account so we can batch-check where possible
  const byAccount = new Map();
  for (const dbRun of runs) {
    const run = dbRun.account_id ? dbRun : {
      ...dbRun,
      account_id: 'env-provider',
      account_name: dbRun.saved_account_name || ENV_PROVIDER_NAME,
      api_url: ENV_PROVIDER_URL,
      api_key: ENV_PROVIDER_KEY,
      delivery_multiplier: 1,
    };
    if (!byAccount.has(run.account_id)) {
      byAccount.set(run.account_id, { prov: run, runs: [] });
    }
    byAccount.get(run.account_id).runs.push(run);
  }

  await Promise.allSettled(
    Array.from(byAccount.values()).map(({ prov, runs: acctRuns }) =>
      checkAccountStatuses(prov, acctRuns)
    )
  );
}

async function checkAccountStatuses(prov, runs) {
  // Try bulk first (comma-separated order IDs), fall back to individual
  const orderIds = runs.map(r => r.provider_order_id);

  let statusMap = new Map(); // orderId → status data

  try {
    // Many SMM panels support: action=status&orders=1,2,3
    const data = await callAccount(prov, {
      action: 'status',
      orders: orderIds.join(','),
    }, 30_000);

    // Response is either an array or an object keyed by order ID
    if (Array.isArray(data)) {
      for (const item of data) {
        const id = String(item.order ?? item.id ?? '');
        if (id) statusMap.set(id, item);
      }
    } else if (data && typeof data === 'object') {
      for (const [key, val] of Object.entries(data)) {
        statusMap.set(String(key), val);
      }
    }
  } catch {
    // Bulk not supported — fall back to individual checks
    for (const run of runs) {
      try {
        const data = await callAccount(prov, {
          action: 'status',
          order:  run.provider_order_id,
        }, 15_000);
        statusMap.set(run.provider_order_id, data);
      } catch {
        // Mark as checked so we don't spam
        await query(
          `UPDATE organic_run_schedule SET last_status_check=now() WHERE id=$1`,
          [run.id]
        ).catch(() => {});
      }
    }
  }

  // Apply status updates
  await Promise.allSettled(runs.map(run => applyStatus(run, statusMap.get(run.provider_order_id))));
}

const COMPLETED_STATUSES  = new Set(['completed', 'complete']);
const CANCELLED_STATUSES  = new Set(['canceled', 'cancelled', 'refunded']);
const IN_PROGRESS_STATUSES = new Set(['in progress', 'inprogress', 'processing', 'pending', 'partial']);

async function applyStatus(run, data) {
  // Always update last_status_check
  const rawStatus  = String(data?.status ?? '').toLowerCase().trim();
  const remains    = data?.remains    !== undefined ? Number(data.remains)    : null;
  const startCount = data?.start_count !== undefined ? Number(data.start_count) : null;
  const charge     = data?.charge     !== undefined ? Number(data.charge)     : null;

  if (!data || !rawStatus) {
    // No data — just bump the timestamp
    await query(
      `UPDATE organic_run_schedule SET last_status_check=now() WHERE id=$1`,
      [run.id]
    ).catch(() => {});
    return;
  }

  if (COMPLETED_STATUSES.has(rawStatus)) {
    // Provider confirms delivery done
    await query(
      `UPDATE organic_run_schedule
          SET status='completed',
              completed_at=now(),
              provider_status=$1,
              provider_remains=$2,
              provider_start_count=$3,
              provider_charge=$4,
              last_status_check=now()
        WHERE id=$5 AND status='processing'`,
      [rawStatus, remains, startCount, charge, run.id]
    );
    console.log(`[cron] ✅ Run ${run.id} confirmed completed by provider (order ${run.provider_order_id})`);

  } else if (CANCELLED_STATUSES.has(rawStatus)) {
    // Provider cancelled — fail the run so the order can be refunded/retried
    await query(
      `UPDATE organic_run_schedule
          SET status='failed',
              completed_at=now(),
              provider_status=$1,
              provider_remains=$2,
              provider_charge=$3,
              error_message='Provider cancelled: ' || $1,
              last_status_check=now()
        WHERE id=$4 AND status='processing'`,
      [rawStatus, remains, charge, run.id]
    );
    console.warn(`[cron] ⚠️ Run ${run.id} cancelled by provider (${rawStatus})`);

  } else {
    // Still in progress — update fields and wait for next tick
    await query(
      `UPDATE organic_run_schedule
          SET provider_status=$1,
              provider_remains=$2,
              provider_start_count=$3,
              provider_charge=$4,
              last_status_check=now()
        WHERE id=$5`,
      [rawStatus, remains, startCount, charge, run.id]
    );
  }
}

// ── Startup + scheduling ──────────────────────────────────────────────────────

export function isCronReady(isReady = areEngagementOrderWritesReady) {
  return isReady();
}

export function startCron({ isReady = areEngagementOrderWritesReady } = {}) {
  if (!isCronReady(isReady)) {
    console.warn('[cron] Dispatcher remains stopped until historical orders are ready');
    return false;
  }

  console.log(`[cron] Organic run dispatcher started (batch=${BATCH_SIZE}, tick=${TICK_MS / 1000}s)`);

  recoverSimulatedRuns()
    .then(count => {
      if (count > 0) console.log(`[cron] ♻ Recovered ${count} simulated run(s) for real provider dispatch`);
    })
    .catch(e => console.error('[cron] Simulated-run recovery error:', e));

  // Reset runs that were mid-dispatch when the server last restarted.
  query(`
    UPDATE organic_run_schedule ors
       SET status = 'pending',
           retry_count = GREATEST(retry_count, 1),
           error_message = 'Reset: server restarted mid-dispatch',
           started_at = NULL
      FROM engagement_order_items eoi
      JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
     WHERE eoi.id = ors.engagement_order_item_id
       AND eo.order_number >= $1
       AND ors.status = 'started'
       AND ors.started_at < now() - interval '5 minutes'
  `, [MIN_LIVE_ORDER_NUMBER]).then(r => {
    if (r.rowCount > 0) console.log(`[cron] ♻ Reset ${r.rowCount} orphaned 'started' run(s) to pending`);
  }).catch(e => console.error('[cron] Orphan reset error:', e));

  // Also move any existing 'completed' runs that have no provider_status back to 'processing'
  // so the status-check loop picks them up. This handles runs placed before this fix.
  query(`
    UPDATE organic_run_schedule ors
       SET status = 'processing',
           last_status_check = NULL
      FROM engagement_order_items eoi
      JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
     WHERE eoi.id = ors.engagement_order_item_id
       AND eo.order_number >= $1
       AND ors.status = 'completed'
       AND ors.provider_order_id IS NOT NULL
       AND ors.provider_order_id NOT LIKE 'sim_%'
       AND ors.provider_status IS NULL
       AND ors.completed_at > now() - interval '7 days'
  `, [MIN_LIVE_ORDER_NUMBER]).then(r => {
    if (r.rowCount > 0) console.log(`[cron] 🔄 Re-queued ${r.rowCount} unverified run(s) for status check`);
  }).catch(e => console.error('[cron] Re-queue error:', e));

  setTimeout(() => {
    const tick = () => {
      if (!isCronReady(isReady)) return;
      processBatch().catch(e => console.error('[cron] Dispatch error:', e));
      checkProcessingRuns().catch(e => console.error('[cron] Status-check error:', e));
    };
    tick();
    setInterval(tick, TICK_MS);
  }, 5000);

  return true;
}
