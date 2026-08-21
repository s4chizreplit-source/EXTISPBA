/**
 * POST /api/engagement-orders/create
 * Replaces the Supabase edge function: process-engagement-order
 */
import express from 'express';
import { query, withTx } from '../db.js';
import { requireAuth, ah } from '../middleware/auth.js';

const router = express.Router();

// ── Scheduling constants (ported from edge function) ──────────────────────────

const MAX_BATCH_CAPS = {
  views: 200, likes: 35, comments: 3, saves: 20, shares: 25,
  followers: 8, subscribers: 5, retweets: 35, reposts: 30,
  watch_hours: 1, story_views: 200, impressions: 300, reach: 250,
  profile_visits: 15, mentions: 3, quotes: 4, bookmarks: 25,
  favorites: 35, plays: 200, listens: 150, downloads: 5, generic: 50,
};

const SERVICE_CONFIGS = {
  views:       { baseIntervalMinutes: 45, intervalVariance: 25, runsPerThousand: 20,  minRunsPerOrder: 25, maxRunsPerOrder: 300, defaultMinQty: 100 },
  likes:       { baseIntervalMinutes: 85, intervalVariance: 45, runsPerThousand: 180, minRunsPerOrder: 10, maxRunsPerOrder: 200, defaultMinQty: 10 },
  comments:    { baseIntervalMinutes: 150, intervalVariance: 80, runsPerThousand: 250, minRunsPerOrder: 15, maxRunsPerOrder: 150, defaultMinQty: 5 },
  followers:   { baseIntervalMinutes: 300, intervalVariance: 150, runsPerThousand: 80, minRunsPerOrder: 15, maxRunsPerOrder: 120, defaultMinQty: 10 },
  subscribers: { baseIntervalMinutes: 360, intervalVariance: 180, runsPerThousand: 120, minRunsPerOrder: 12, maxRunsPerOrder: 100, defaultMinQty: 10 },
  retweets:    { baseIntervalMinutes: 70,  intervalVariance: 38,  runsPerThousand: 65,  minRunsPerOrder: 18, maxRunsPerOrder: 150, defaultMinQty: 10 },
  shares:      { baseIntervalMinutes: 100, intervalVariance: 55,  runsPerThousand: 250, minRunsPerOrder: 3,  maxRunsPerOrder: 120, defaultMinQty: 10 },
  saves:       { baseIntervalMinutes: 110, intervalVariance: 60,  runsPerThousand: 180, minRunsPerOrder: 2,  maxRunsPerOrder: 100, defaultMinQty: 10 },
  watch_hours: { baseIntervalMinutes: 480, intervalVariance: 240, runsPerThousand: 1000, minRunsPerOrder: 8, maxRunsPerOrder: 50,  defaultMinQty: 1 },
  reposts:     { baseIntervalMinutes: 85,  intervalVariance: 45,  runsPerThousand: 120, minRunsPerOrder: 2,  maxRunsPerOrder: 120, defaultMinQty: 10 },
  generic:     { baseIntervalMinutes: 80,  intervalVariance: 45,  runsPerThousand: 50,  minRunsPerOrder: 2,  maxRunsPerOrder: 150, defaultMinQty: 10 },
};

const PROVIDER_MINIMUMS = {
  views: 100, likes: 10, comments: 10, saves: 10, shares: 10,
  followers: 10, subscribers: 10, retweets: 10, reposts: 10, watch_hours: 10,
};

const PLATFORM_PRIORITIES = {
  views: 1, impressions: 1, plays: 1, watch_hours: 1, reach: 1,
  likes: 2, favorites: 2, comments: 3, saves: 4, bookmarks: 4,
  shares: 5, retweets: 5, reposts: 5, followers: 6, subscribers: 6, generic: 10,
};

function getServiceConfig(engType) {
  return SERVICE_CONFIGS[engType] || SERVICE_CONFIGS.generic;
}

function clampVariance(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(5, Math.min(60, numeric)) : 25;
}

function randomInt(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Make run quantities and gaps organic/unique while preserving the exact total. */
export function uniquifyScheduledRuns(runs, totalTargetQty, providerMin, maxBatchCap, variancePercent = 25) {
  let base = runs
    .map((run, index) => ({
      run_number: index + 1,
      at: new Date(run.scheduled_at).getTime(),
      quantity_to_send: Math.max(0, Math.round(Number(run.quantity_to_send) || 0)),
      base_quantity: Math.max(0, Math.round(Number(run.base_quantity ?? run.quantity_to_send) || 0)),
      variance_applied: Number(run.variance_applied ?? 0),
      peak_multiplier: Number(run.peak_multiplier ?? 1),
      status: 'pending',
    }))
    .filter(r => r.quantity_to_send > 0)
    .sort((a, b) => a.at - b.at);

  if (base.length === 0) return [];

  const total = Math.max(1, Math.round(Number(totalTargetQty) || 0));
  const previewMax = base.reduce((m, r) => Math.max(m, r.quantity_to_send), 0);
  const cap = Math.max(
    maxBatchCap,
    Math.ceil(previewMax * 1.35),
    Math.ceil((total / base.length) * 1.25)
  );
  const floor = Math.max(1, providerMin);

  // A provider floor can make the preview's run count impossible. Trim only
  // as many tail runs as needed; this applies to newly-created orders only.
  while (base.length > 1 && floor * base.length > total) {
    base = base.slice(0, -1);
  }

  const variance = clampVariance(variancePercent) / 100;
  const average = total / base.length;
  const preferredLow = Math.max(floor, Math.floor(average * (1 - variance)));
  const preferredHigh = Math.min(cap, Math.ceil(average * (1 + variance)));
  const usedQty = new Set();
  const quantities = [];
  let remaining = total;

  for (let i = 0; i < base.length; i++) {
    const runsAfter = base.length - i - 1;
    if (runsAfter === 0) {
      quantities.push(remaining);
      break;
    }

    const feasibleLow = Math.max(floor, remaining - cap * runsAfter);
    const feasibleHigh = Math.min(cap, remaining - floor * runsAfter);
    let low = Math.max(feasibleLow, preferredLow);
    let high = Math.min(feasibleHigh, preferredHigh);
    if (low > high) {
      low = feasibleLow;
      high = feasibleHigh;
    }

    let quantity = randomInt(low, high);
    for (let attempt = 0; attempt < 80; attempt++) {
      const candidate = randomInt(low, high);
      const tooRound = candidate % 10 === 0 || candidate % 25 === 0 || candidate % 50 === 0;
      const tooClose = quantities.some(previous => Math.abs(previous - candidate) < 3);
      if (!usedQty.has(candidate) && !tooRound && !tooClose) {
        quantity = candidate;
        break;
      }
    }
    quantities.push(quantity);
    usedQty.add(quantity);
    remaining -= quantity;
  }

  // Shuffle the generated quantities so growth does not form a visible ramp.
  for (let i = quantities.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [quantities[i], quantities[j]] = [quantities[j], quantities[i]];
  }

  base.forEach((run, i) => {
    run.quantity_to_send = quantities[i];
    run.base_quantity = quantities[i];
    run.variance_applied = Math.round((quantities[i] / average - 1) * 100);
  });

  // Randomize gaps between runs
  const firstAt = base[0].at;
  const spanMs = Math.max(base.length * 5 * 60000, base[base.length - 1].at - firstAt);
  const avgGap = spanMs / Math.max(1, base.length - 1);
  const usedGaps = new Set();
  let cursor = firstAt;
  const gapSpread = Math.max(0.2, Math.min(0.75, variance * 1.8));

  base.forEach((run, i) => {
    if (i === 0) { run.at = firstAt; return; }
    let gap = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      const wobble = (1 - gapSpread) + Math.random() * gapSpread * 2;
      const burst = Math.random() < 0.18 ? 0.35 : 1;
      const candidate = Math.round(avgGap * wobble * burst / 60000);
      const minutes = Math.max(4, candidate) + (Math.random() < 0.5 ? 0 : 1);
      const secs = Math.floor(Math.random() * 60);
      const g = minutes * 60000 + secs * 1000;
      if (usedGaps.has(minutes)) continue;
      usedGaps.add(minutes);
      gap = g;
      break;
    }
    if (!gap) gap = Math.round(avgGap) + Math.floor(Math.random() * 180000);
    cursor += gap;
    run.at = cursor;
  });

  return base.map((run, i) => ({
    run_number: i + 1,
    scheduled_at: new Date(run.at).toISOString(),
    quantity_to_send: run.quantity_to_send,
    base_quantity: run.base_quantity,
    variance_applied: run.variance_applied,
    peak_multiplier: run.peak_multiplier,
    status: 'pending',
  }));
}

/** Generate a fully organic run schedule with randomised quantities and gaps */
export function generateRunSchedule(
  engagement,
  providerMin,
  maxBatchCap,
  initialDelayMs,
  timeLimitHours,
  variancePercent = 25
) {
  const config = getServiceConfig(engagement.type);
  const startTime = Date.now() + initialDelayMs;

  let baseInterval = config.baseIntervalMinutes;
  let intervalRange = config.intervalVariance;

  const idealRuns = Math.round((engagement.quantity / 1000) * config.runsPerThousand);
  const maxPosForQty = Math.max(1, Math.floor(engagement.quantity / providerMin));
  const absoluteMaxRuns = Math.max(1, Math.floor(maxPosForQty * 0.8));

  let targetRuns;
  if (timeLimitHours > 0) {
    const totalMinutes = timeLimitHours * 60;
    const availableMinutes = Math.max(30, totalMinutes - initialDelayMs / 60000);
    const maxPosRuns = Math.floor(availableMinutes / 5);
    targetRuns = Math.min(Math.max(config.minRunsPerOrder, Math.min(config.maxRunsPerOrder, idealRuns)), maxPosRuns, absoluteMaxRuns);
    if (targetRuns < 2 && engagement.quantity >= providerMin * 2) targetRuns = 2;
    const avgNeeded = Math.ceil(engagement.quantity / targetRuns);
    maxBatchCap = Math.max(maxBatchCap, Math.min(avgNeeded * 2, providerMin * 4));
    baseInterval = Math.max(5, availableMinutes / Math.max(targetRuns - 1, 1));
    intervalRange = baseInterval * 0.15;
  } else {
    targetRuns = Math.max(config.minRunsPerOrder, Math.ceil(engagement.quantity / maxBatchCap), Math.min(config.maxRunsPerOrder, idealRuns));
    targetRuns = Math.min(targetRuns, absoluteMaxRuns);
    if (targetRuns < 2 && engagement.quantity >= providerMin * 2) targetRuns = 2;
  }

  // ── Organic quantity distribution ─────────────────────────────────────────
  // Instead of dividing evenly, assign random weights then scale to total.
  const cap   = maxBatchCap;
  const floor = providerMin;
  const total = engagement.quantity;

  // Generate random weights using the user's selected organic variance.
  const quantityVariance = clampVariance(variancePercent) / 100;
  const weights = Array.from(
    { length: targetRuns },
    () => (1 - quantityVariance) + Math.random() * quantityVariance * 2
  );
  const weightSum = weights.reduce((s, w) => s + w, 0);

  // Scale to total, clamp to [floor, cap]
  let quantities = weights.map(w => Math.max(floor, Math.min(cap, Math.round((w / weightSum) * total))));

  // Reconcile drift so quantities sum exactly to total
  let drift = total - quantities.reduce((s, q) => s + q, 0);
  let guard = 0;
  while (drift !== 0 && guard < 10000) {
    guard++;
    const idx = Math.floor(Math.random() * quantities.length);
    const step = drift > 0 ? 1 : -1;
    const next = quantities[idx] + step;
    if (next >= floor && next <= cap) {
      quantities[idx] = next;
      drift -= step;
    }
  }
  // Last-resort: dump remainder into last run
  if (drift !== 0) quantities[quantities.length - 1] = Math.max(floor, quantities[quantities.length - 1] + drift);

  // ── Organic timing ─────────────────────────────────────────────────────────
  const runs = [];
  let currentTime = startTime;
  const usedGapMinutes = new Set();

  for (let i = 0; i < targetRuns; i++) {
    const scheduledAt = new Date(currentTime + (Math.random() * 2 - 1) * 90 * 1000);
    if (scheduledAt.getTime() < Date.now() + 30000) scheduledAt.setTime(Date.now() + 30000);

    runs.push({
      run_number: i + 1,
      scheduled_at: scheduledAt.toISOString(),
      quantity_to_send: quantities[i],
      base_quantity: quantities[i],
      variance_applied: Math.round((quantities[i] / (total / targetRuns) - 1) * 100),
      peak_multiplier: 1,
      status: 'pending',
    });

    // Organic gap: pick a gap that hasn't been used before
    let gap = 0;
    for (let attempt = 0; attempt < 40; attempt++) {
      const wobble = 0.55 + Math.random() * 1.2;
      const burst  = Math.random() < 0.15 ? 0.4 : 1;
      const mins   = Math.max(4, Math.round(baseInterval * wobble * burst));
      if (!usedGapMinutes.has(mins)) {
        usedGapMinutes.add(mins);
        gap = mins * 60 * 1000 + Math.floor(Math.random() * 60) * 1000;
        break;
      }
    }
    if (!gap) gap = Math.round(baseInterval * 60 * 1000) + Math.floor(Math.random() * 180000);
    currentTime += gap;
  }

  return runs;
}


// ── POST /api/engagement-orders/create ───────────────────────────────────────

router.post('/create', requireAuth, ah(async (req, res) => {
  const userId = req.session.userId;
  const { bundle_id, link, base_quantity, total_price, is_organic_mode, engagements, campaign_name } = req.body;

  if (!bundle_id || !Array.isArray(engagements) || engagements.length === 0 || !total_price || total_price <= 0) {
    return res.status(400).json({ error: 'Invalid request body' });
  }
  if (!link || !link.trim()) {
    return res.status(400).json({ error: 'Link is required' });
  }

  // ── Validate bundle items + price ─────────────────────────────────────────
  const { rows: bItems } = await query(
    `SELECT bi.service_id, bi.engagement_type, bi.price_per_k, s.min_quantity
       FROM bundle_items bi
       LEFT JOIN services s ON s.id = bi.service_id
      WHERE bi.bundle_id = $1`,
    [bundle_id]
  );
  if (!bItems.length) return res.status(400).json({ error: 'Bundle not found or empty' });

  let expectedTotal = 0;
  for (const eng of engagements) {
    const qty = Math.max(0, Math.floor(Number(eng?.quantity) || 0));
    if (qty <= 0) return res.status(400).json({ error: 'Invalid engagement quantity' });
    const match = bItems.find(b => b.engagement_type === eng.type && (!eng.service_id || b.service_id === eng.service_id));
    if (!match) return res.status(400).json({ error: `Engagement type "${eng.type}" not in bundle` });
    expectedTotal += (qty / 1000) * Number(match.price_per_k || 0);
  }
  if (expectedTotal <= 0 || Math.abs(Number(total_price) - expectedTotal) / expectedTotal > 0.02) {
    return res.status(400).json({ error: `Price mismatch: expected ≈${expectedTotal.toFixed(6)}, got ${total_price}` });
  }

  const sanitizedCampaignName = typeof campaign_name === 'string' ? campaign_name.trim().slice(0, 120) || null : null;
  const orderVariance = clampVariance(engagements[0]?.variance_percent);

  // ── Atomic: debit wallet + create order + create items ───────────────────
  const { order, itemRows } = await withTx(async (client) => {
    // Lock & check wallet
    const { rows: wRows } = await client.query(
      `SELECT id, balance, total_spent FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    if (!wRows[0]) throw Object.assign(new Error('Wallet not found'), { status: 400 });
    const wallet = wRows[0];
    if (Number(wallet.balance) < Number(total_price)) {
      throw Object.assign(new Error('Insufficient balance'), { status: 400 });
    }

    const newBalance = Number(wallet.balance) - Number(total_price);
    const newSpent   = Number(wallet.total_spent || 0) + Number(total_price);

    await client.query(
      `UPDATE wallets SET balance=$1, total_spent=$2, updated_at=now() WHERE id=$3`,
      [newBalance, newSpent, wallet.id]
    );

    // Create the order
    const { rows: [ord] } = await client.query(
      `INSERT INTO engagement_orders
         (user_id, bundle_id, link, base_quantity, total_price, is_organic_mode,
          variance_percent, peak_hours_enabled, status, campaign_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'processing',$9)
       RETURNING *`,
      [userId, bundle_id, link.trim(), base_quantity, total_price, is_organic_mode ?? true,
       orderVariance, true, sanitizedCampaignName]
    );

    // Record transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_after, order_id, status, description)
       VALUES ($1,'order_payment',$2,$3,$4,'completed',$5)`,
      [userId, total_price, newBalance, ord.id, `Engagement Order #${ord.order_number}`]
    );

    // Create items
    const items = [];
    for (const eng of engagements) {
      const { rows: [item] } = await client.query(
        `INSERT INTO engagement_order_items
           (engagement_order_id, engagement_type, service_id, quantity, price, status)
         VALUES ($1,$2,$3,$4,$5,'pending')
         RETURNING *`,
        [ord.id, eng.type, eng.service_id, eng.quantity, eng.price]
      );
      items.push({ item, engagement: eng });
    }

    return { order: ord, itemRows: items };
  });

  // ── Schedule runs (async, outside tx) ────────────────────────────────────
  const startTime = Date.now();
  const sortedItems = [...itemRows].sort((a, b) =>
    (PLATFORM_PRIORITIES[a.item.engagement_type] || 10) - (PLATFORM_PRIORITIES[b.item.engagement_type] || 10)
  );

  let viewsStartMs = null;

  for (const { item, engagement } of sortedItems) {
    const engType = item.engagement_type;
    const config = getServiceConfig(engType);
    const baseMaxBatchCap = MAX_BATCH_CAPS[engType] || MAX_BATCH_CAPS.generic;
    const floorMin = PROVIDER_MINIMUMS[engType] || 0;

    // Get provider min from bundle items
    const bItem = bItems.find(b => b.engagement_type === engType);
    let providerMin = Math.max(config.defaultMinQty, floorMin, Number(bItem?.min_quantity || 0));

    const isViewType = ['views', 'impressions', 'reach', 'plays', 'watch_hours'].includes(engType);
    let initialDelayMs;

    if (isViewType && viewsStartMs === null) {
      initialDelayMs = (0.5 + Math.random() * 0.5) * 60 * 1000;
      viewsStartMs = startTime + initialDelayMs;
    } else if (viewsStartMs !== null) {
      const priority = PLATFORM_PRIORITIES[engType] || 10;
      const stepDelay = 5 + (priority - 1) * 8;
      initialDelayMs = stepDelay * 60 * 1000 + Math.random() * 15 * 60 * 1000;
    } else {
      const priority = PLATFORM_PRIORITIES[engType] || 10;
      initialDelayMs = ((priority - 1) * 60 + 20) * 60 * 1000;
    }

    const timeLimitHours = typeof engagement.time_limit_hours === 'number' && engagement.time_limit_hours > 0
      ? engagement.time_limit_hours : 0;

    const maxBatchCap = Math.max(baseMaxBatchCap, Math.round(providerMin * 2.5));
    const previewRuns = Array.isArray(engagement.scheduled_runs) ? engagement.scheduled_runs : [];
    const variancePercent = clampVariance(engagement.variance_percent);

    const candidateRuns = previewRuns.length > 0
      ? previewRuns
      : generateRunSchedule(
          engagement,
          providerMin,
          maxBatchCap,
          initialDelayMs,
          timeLimitHours,
          variancePercent
        );
    let finalRuns = uniquifyScheduledRuns(
      candidateRuns,
      engagement.quantity,
      providerMin,
      maxBatchCap,
      variancePercent
    );

    if (finalRuns.length === 0) {
      // Fallback: one immediate run
      finalRuns = [{
        run_number: 1,
        scheduled_at: new Date(startTime + 30000).toISOString(),
        quantity_to_send: engagement.quantity,
        base_quantity: engagement.quantity,
        variance_applied: 0,
        peak_multiplier: 1,
        status: 'pending',
      }];
    }

    // Bulk insert runs
    if (finalRuns.length > 0) {
      const vals = finalRuns.map((r, i) =>
        `($${i * 7 + 1},$${i * 7 + 2},$${i * 7 + 3},$${i * 7 + 4},$${i * 7 + 5},$${i * 7 + 6},$${i * 7 + 7})`
      ).join(',');
      const params = finalRuns.flatMap(r => [
        item.id, r.run_number, r.scheduled_at,
        r.quantity_to_send, r.base_quantity, r.variance_applied, r.peak_multiplier,
      ]);
      await query(
        `INSERT INTO organic_run_schedule
           (engagement_order_item_id, run_number, scheduled_at,
            quantity_to_send, base_quantity, variance_applied, peak_multiplier)
         VALUES ${vals}`,
        params
      );
    }
  }

  res.status(201).json({
    order_number: order.order_number,
    id: order.id,
    status: order.status,
    total_price: order.total_price,
  });
}));

// PATCH /items/:itemId/refill — update auto_refill settings on engagement_order_items
router.patch('/items/:itemId/refill', requireAuth, ah(async (req, res) => {
  const allowed = ['auto_refill_enabled', 'auto_refill_threshold_pct', 'auto_refill_max'];
  const patch = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No valid fields' });
  const setClauses = Object.keys(patch).map((k, i) => `${k} = $${i + 2}`).join(', ');
  await query(
    `UPDATE engagement_order_items SET ${setClauses} WHERE id = $1`,
    [req.params.itemId, ...Object.values(patch)]
  );
  res.json({ ok: true });
}));

// POST /runs/:runId/check-status — return current DB status (cron keeps it updated every 15s)
router.post('/runs/:runId/check-status', requireAuth, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT ors.status, ors.provider_order_id, ors.provider_status,
            ors.provider_start_count, ors.provider_remains, ors.error_message,
            ors.last_status_check
     FROM organic_run_schedule ors
     JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
     JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
     WHERE ors.id = $1 AND eo.user_id = $2`,
    [req.params.runId, req.session.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Run not found' });
  res.json({ ok: true, run: rows[0] });
}));

// POST /runs/check-all-status — aggregate counts for the current user
router.post('/runs/check-all-status', requireAuth, ah(async (req, res) => {
  const { rows } = await query(
    `SELECT ors.status, COUNT(*)::int as count
     FROM organic_run_schedule ors
     JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
     JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
     WHERE eo.user_id = $1
     GROUP BY ors.status`,
    [req.session.userId]
  );
  const counts = Object.fromEntries(rows.map(r => [r.status, r.count]));
  res.json({
    completed: counts.completed || 0,
    stillProcessing: counts.processing || 0,
    pending: counts.pending || 0,
  });
}));

// POST /runs/:runId/reschedule — update a pending run's quantity and scheduled time
router.post('/runs/:runId/reschedule', requireAuth, ah(async (req, res) => {
  const { quantity, scheduledAt } = req.body || {};
  if (!quantity || !scheduledAt) return res.status(400).json({ error: 'quantity and scheduledAt required' });

  const { rows } = await query(
    `SELECT ors.id, ors.status, ors.quantity_to_send, eo.user_id
     FROM organic_run_schedule ors
     JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
     JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
     WHERE ors.id = $1`,
    [req.params.runId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Run not found' });
  const run = rows[0];
  if (run.user_id !== req.session.userId && req.session.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  if (run.status !== 'pending') return res.status(400).json({ error: 'Only pending runs can be rescheduled' });

  await query(
    `UPDATE organic_run_schedule SET quantity_to_send = $1, scheduled_at = $2 WHERE id = $3`,
    [Number(quantity), scheduledAt, req.params.runId]
  );
  res.json({ success: true, extra_charged: 0, new_balance: 0 });
}));

export default router;
