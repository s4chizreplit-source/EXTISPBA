/**
 * Organic run dispatcher — runs every 15 seconds.
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

const BATCH_SIZE = 25;
const TICK_MS    = 15_000;

/** True when the provider error means "same link is already active". */
function isActiveLinkError(msg = '') {
  const m = msg.toLowerCase();
  return (
    m.includes('active order with this link') ||
    m.includes('already have an active order') ||
    m.includes('order with same link')
  );
}

/** Low-level HTTP call to one SMM panel account. */
async function callAccount({ api_url, api_key }, params, timeoutMs = 20_000) {
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
         AND eo.status  NOT IN ('cancelled','paused','completed')
         AND eoi.status NOT IN ('cancelled','paused','completed','failed')
       ORDER BY ors.scheduled_at ASC
       LIMIT $1
       FOR UPDATE OF ors SKIP LOCKED
    `, [BATCH_SIZE]);

    if (locked.length === 0) return [];
    const ids = locked.map(r => r.id);

    // Step 2 — mark 'started' so other ticks never re-pick these rows.
    await client.query(
      `UPDATE organic_run_schedule SET status='started', started_at=now() WHERE id = ANY($1)`,
      [ids]
    );

    // Step 3 — fetch full details + ALL provider accounts ordered by priority.
    //           One row per (run × provider_account); we group in JS.
    const { rows } = await client.query(`
      SELECT
        ors.id,
        ors.quantity_to_send,
        ors.engagement_order_item_id,
        ors.retry_count,
        eo.link,
        eo.id                                                     AS order_id,
        COALESCE(spm.provider_service_id, s.provider_service_id)  AS provider_service_id,
        COALESCE(spm.sort_order, 999)                             AS sort_order,
        pa.id                                                     AS account_id,
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
             ON pa.id = spm.provider_account_id AND pa.is_active = true
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
          providers: [],
        });
      }
      // Only add a provider row if it has usable credentials
      if (row.account_id && row.api_url && row.api_key && row.provider_service_id) {
        byRun.get(row.id).providers.push({
          account_id:          row.account_id,
          api_url:             row.api_url,
          api_key:             row.api_key,
          provider_service_id: row.provider_service_id,
          delivery_multiplier: Number(row.delivery_multiplier ?? 1),
        });
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

  // ── No providers configured → simulate (service not wired yet) ──────────
  if (providers.length === 0) {
    const simId = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    await query(
      `UPDATE organic_run_schedule
          SET status='completed', completed_at=now(),
              provider_order_id=$1, provider_response=$2
        WHERE id=$3`,
      [simId, JSON.stringify({ simulated: true, reason: 'no_providers' }), run.id]
    );
    console.log(`[cron] 🔵 Run ${run.id} simulated (no providers configured)`);
    return;
  }

  // ── Try providers in priority order ─────────────────────────────────────
  let allBusy  = true;   // flips to false on any non-"active-link" outcome
  let lastErr  = null;

  for (const prov of providers) {
    const sendQty = prov.delivery_multiplier > 0
      ? Math.ceil(run.quantity_to_send / prov.delivery_multiplier)
      : run.quantity_to_send;

    try {
      const data = await callAccount(prov, {
        action:   'add',
        service:  String(prov.provider_service_id),
        link:     run.link,
        quantity: String(sendQty),
      });

      const providerOrderId = String(data.order ?? data.id ?? '');
      if (!providerOrderId) throw new Error('Provider returned no order id');

      // ✅ Success
      allBusy = false;
      await query(
        `UPDATE organic_run_schedule
            SET status='completed',
                completed_at=now(),
                provider_order_id=$1,
                provider_response=$2,
                provider_account_id=$3,
                provider_account_name=(SELECT name FROM provider_accounts WHERE id=$3)
          WHERE id=$4`,
        [providerOrderId, JSON.stringify({ order: providerOrderId }), prov.account_id, run.id]
      );
      // Update LRU stamp so next run rotates to the least-recently-used provider
      query(`UPDATE provider_accounts SET last_used_at=now() WHERE id=$1`, [prov.account_id]).catch(() => {});
      console.log(`[cron] ✅ Run ${run.id} → provider order ${providerOrderId}`);
      return;

    } catch (err) {
      if (isActiveLinkError(err.message)) {
        // This provider has an active order for the same link — try next
        console.log(`[cron] ↩ Run ${run.id}: provider busy (${prov.account_id.slice(0,8)}…), trying next`);
        continue;
      }
      // Real error (timeout, bad API response, etc.) — don't try more providers
      allBusy  = false;
      lastErr  = err;
      break;
    }
  }

  // ── All providers busy with this link → re-queue without penalty ─────────
  if (allBusy) {
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

export function startCron() {
  console.log(`[cron] Organic run dispatcher started (batch=${BATCH_SIZE}, tick=${TICK_MS / 1000}s)`);
  setTimeout(() => {
    processBatch().catch(e => console.error('[cron] Batch error:', e));
    setInterval(() => {
      processBatch().catch(e => console.error('[cron] Batch error:', e));
    }, TICK_MS);
  }, 5000);
}
