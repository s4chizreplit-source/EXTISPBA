/**
 * Organic run dispatcher — runs every 30 seconds.
 * Picks pending organic_run_schedule rows where scheduled_at <= now()
 * and dispatches them to the provider API, then updates status.
 */

import { query, withTx } from './db.js';
import { placeProviderOrder } from './provider.js';

const BATCH_SIZE = 25; // runs per tick
const TICK_MS = 15_000; // 15 seconds

async function processBatch() {
  // SELECT + immediately mark 'started' inside ONE transaction.
  // This holds the row lock until the UPDATE commits, so no second tick
  // can ever pick up the same row, eliminating duplicate dispatches.
  const runs = await withTx(async (client) => {
    // Step 1: lock exactly BATCH_SIZE distinct ors rows (no fan-out joins here).
    const { rows: locked } = await client.query(`
      SELECT ors.id
      FROM organic_run_schedule ors
      JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
      JOIN engagement_orders eo       ON eo.id  = eoi.engagement_order_id
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

    // Step 2: mark all as 'started' before releasing the lock — no second tick
    // can pick these up now (status != 'pending').
    await client.query(
      `UPDATE organic_run_schedule SET status='started', started_at=now() WHERE id = ANY($1)`,
      [ids]
    );

    // Step 3: fetch full details (joins are safe now — no FOR UPDATE needed).
    const { rows } = await client.query(`
      SELECT DISTINCT ON (ors.id)
        ors.id,
        ors.quantity_to_send,
        ors.engagement_order_item_id,
        ors.retry_count,
        eo.link,
        eo.id        AS order_id,
        eo.status    AS order_status,
        eoi.status   AS item_status,
        COALESCE(spm.provider_service_id, s.provider_service_id)  AS provider_service_id,
        pa.id        AS account_id,
        pa.api_url,
        pa.api_key,
        pa.delivery_multiplier
      FROM organic_run_schedule ors
      JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
      JOIN engagement_orders eo       ON eo.id  = eoi.engagement_order_id
      LEFT JOIN services s            ON s.id   = eoi.service_id
      LEFT JOIN service_provider_mapping spm
        ON spm.service_id = s.id AND spm.is_active = true
      LEFT JOIN provider_accounts pa
        ON pa.id = COALESCE(spm.provider_account_id, ors.provider_account_id)
        AND pa.is_active = true
      WHERE ors.id = ANY($1)
      ORDER BY ors.id, pa.last_used_at ASC NULLS FIRST
    `, [ids]);

    return rows;
  });

  if (runs.length === 0) return;

  console.log(`[cron] Processing ${runs.length} overdue run(s)`);

  await Promise.allSettled(runs.map(run => dispatchRun(run)));
}

async function dispatchRun(run) {
  // Row is already marked 'started' by processBatch transaction — no second UPDATE needed here.
  try {
    // Apply delivery_multiplier: if provider over-delivers 2x, we send half the qty
    const multiplier = Number(run.delivery_multiplier ?? 1);
    const sendQty = multiplier > 0
      ? Math.ceil(run.quantity_to_send / multiplier)
      : run.quantity_to_send;

    let providerOrderId, accountId;

    if (run.api_url && run.api_key && run.provider_service_id) {
      // Use the account already joined from DB
      const body = new URLSearchParams({
        key: run.api_key,
        action: 'add',
        service: String(run.provider_service_id),
        link: run.link,
        quantity: String(sendQty),
      });
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(run.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: ctrl.signal,
        });
        const text = await res.text();
        const data = JSON.parse(text);
        if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
        providerOrderId = String(data.order ?? data.id ?? '');
        accountId = run.account_id;
      } finally {
        clearTimeout(t);
      }
      // Mark account as used
      if (accountId) {
        query(`UPDATE provider_accounts SET last_used_at=now() WHERE id=$1`, [accountId]).catch(() => {});
      }
    } else {
      // Fallback: use placeProviderOrder (handles LRU selection itself)
      const result = await placeProviderOrder({
        providerServiceId: run.provider_service_id || null,
        link: run.link,
        quantity: sendQty,
      });
      providerOrderId = result.providerOrderId;
      accountId = result.accountId;
    }

    // Success: update run
    await query(
      `UPDATE organic_run_schedule
          SET status='completed',
              completed_at=now(),
              provider_order_id=$1,
              provider_response=$2,
              provider_account_id=$3,
              provider_account_name=(SELECT name FROM provider_accounts WHERE id=$3)
        WHERE id=$4`,
      [providerOrderId, JSON.stringify({ order: providerOrderId }), accountId, run.id]
    );
    console.log(`[cron] ✅ Run ${run.id} → provider order ${providerOrderId}`);

  } catch (err) {
    const retryCount = (run.retry_count ?? 0) + 1;
    const newStatus = retryCount >= 3 ? 'failed' : 'pending';
    // Schedule retry 5 minutes out if not exhausted
    const nextScheduled = newStatus === 'pending'
      ? `now() + interval '5 minutes'`
      : 'scheduled_at';

    await query(
      `UPDATE organic_run_schedule
          SET status=$1,
              error_message=$2,
              retry_count=$3,
              scheduled_at=${nextScheduled},
              completed_at=${newStatus === 'failed' ? 'now()' : 'NULL'}
        WHERE id=$4`,
      [newStatus, err.message?.slice(0, 500), retryCount, run.id]
    );
    console.warn(`[cron] ❌ Run ${run.id} failed (attempt ${retryCount}): ${err.message}`);
  }
}

export function startCron() {
  console.log(`[cron] Organic run dispatcher started (batch=${BATCH_SIZE}, tick=${TICK_MS/1000}s)`);
  // First tick shortly after startup
  setTimeout(() => {
    processBatch().catch(e => console.error('[cron] Batch error:', e));
    setInterval(() => {
      processBatch().catch(e => console.error('[cron] Batch error:', e));
    }, TICK_MS);
  }, 5000); // 5s delay on startup
}
