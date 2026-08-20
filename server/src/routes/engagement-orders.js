import express from 'express';
import { query } from '../db.js';
import { ah, requireAuth } from '../middleware/auth.js';

const router = express.Router();

// GET /api/engagement-orders  — list for logged-in user
router.get('/', requireAuth, ah(async (req, res) => {
  const userId = req.session.userId;

  const { rows: orders } = await query(
    `SELECT
       eo.id, eo.order_number, eo.status, eo.total_price, eo.link,
       eo.base_quantity, eo.created_at, eo.updated_at, eo.is_organic_mode,
       eo.campaign_name, eo.current_health_score, eo.current_botting_percent
     FROM engagement_orders eo
     WHERE eo.user_id = $1
     ORDER BY eo.created_at DESC
     LIMIT 1000`,
    [userId]
  );

  if (orders.length === 0) return res.json([]);

  const orderIds = orders.map(o => o.id);

  // Fetch items for all orders in one query
  const { rows: items } = await query(
    `SELECT
       eoi.id, eoi.engagement_order_id, eoi.engagement_type, eoi.quantity,
       eoi.status, eoi.price, eoi.drip_qty_per_run, eoi.drip_interval,
       eoi.drip_interval_unit, eoi.speed_preset, eoi.is_enabled,
       eoi.auto_refill_enabled, eoi.auto_refill_threshold_pct,
       eoi.auto_refill_count, eoi.auto_refill_max
     FROM engagement_order_items eoi
     WHERE eoi.engagement_order_id = ANY($1)`,
    [orderIds]
  );

  // Fetch organic run schedules for all items
  const itemIds = items.map(i => i.id);
  let runs = [];
  if (itemIds.length > 0) {
    const { rows } = await query(
      `SELECT
         ors.id, ors.engagement_order_item_id, ors.status, ors.quantity_to_send,
         ors.scheduled_at, ors.run_number, ors.provider_status,
         ors.provider_remains, ors.provider_start_count, ors.provider_charge,
         ors.error_message
       FROM organic_run_schedule ors
       WHERE ors.engagement_order_item_id = ANY($1)
       ORDER BY ors.run_number ASC`,
      [itemIds]
    );
    runs = rows;
  }

  // Group runs by item id
  const runsByItem = {};
  for (const run of runs) {
    if (!runsByItem[run.engagement_order_item_id]) runsByItem[run.engagement_order_item_id] = [];
    runsByItem[run.engagement_order_item_id].push(run);
  }

  // Group items by order id
  const itemsByOrder = {};
  for (const item of items) {
    if (!itemsByOrder[item.engagement_order_id]) itemsByOrder[item.engagement_order_id] = [];
    itemsByOrder[item.engagement_order_id].push({
      ...item,
      runs: runsByItem[item.id] || [],
    });
  }

  // Assemble final response in Supabase-compatible shape
  const result = orders.map(order => ({
    ...order,
    items: itemsByOrder[order.id] || [],
  }));

  res.json(result);
}));

// Helper: build full order detail object from DB rows
async function buildOrderDetail(orderId) {
  const { rows: items } = await query(
    `SELECT eoi.*, s.name AS service_name, s.price AS service_price, s.min_quantity AS service_min_quantity
       FROM engagement_order_items eoi
       LEFT JOIN services s ON s.id = eoi.service_id
      WHERE eoi.engagement_order_id = $1`,
    [orderId]
  );
  const itemIds = items.map(i => i.id);
  let runs = [];
  if (itemIds.length > 0) {
    const { rows: r } = await query(
      `SELECT * FROM organic_run_schedule WHERE engagement_order_item_id = ANY($1) ORDER BY run_number ASC`,
      [itemIds]
    );
    runs = r;
  }
  const runsByItem = {};
  for (const run of runs) {
    if (!runsByItem[run.engagement_order_item_id]) runsByItem[run.engagement_order_item_id] = [];
    runsByItem[run.engagement_order_item_id].push(run);
  }
  return items.map(item => ({
    ...item,
    service: item.service_name ? { name: item.service_name, price: item.service_price, min_quantity: item.service_min_quantity } : null,
    runs: runsByItem[item.id] || [],
  }));
}

// GET /api/engagement-orders/by-number/:orderNumber  — fetch by order_number (for detail page)
router.get('/by-number/:orderNumber', requireAuth, ah(async (req, res) => {
  const userId = req.session.userId;
  const isAdmin = req.session.role === 'admin';
  const orderNumber = parseInt(req.params.orderNumber);
  if (isNaN(orderNumber)) return res.status(400).json({ error: 'Invalid order number' });

  const { rows } = await query(
    `SELECT eo.*, eb.id AS bundle_id, eb.name AS bundle_name
       FROM engagement_orders eo
       LEFT JOIN engagement_bundles eb ON eb.id = eo.bundle_id
      WHERE eo.order_number = $1 AND ($2 OR eo.user_id = $3)`,
    [orderNumber, isAdmin, userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });

  const order = rows[0];
  const items = await buildOrderDetail(order.id);
  const bundle = order.bundle_id ? { id: order.bundle_id, name: order.bundle_name } : null;
  res.json({ ...order, bundle, items });
}));

// GET /api/engagement-orders/:id  — single order detail by UUID
router.get('/:id', requireAuth, ah(async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { rows } = await query(
    `SELECT eo.*, eb.id AS bundle_id, eb.name AS bundle_name
       FROM engagement_orders eo
       LEFT JOIN engagement_bundles eb ON eb.id = eo.bundle_id
      WHERE eo.id = $1 AND eo.user_id = $2`,
    [id, userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
  const order = rows[0];
  const items = await buildOrderDetail(order.id);
  const bundle = order.bundle_id ? { id: order.bundle_id, name: order.bundle_name } : null;
  res.json({ ...order, bundle, items });
}));

// PATCH /api/engagement-orders/:id/status  — cancel/pause/resume
router.patch('/:id/status', requireAuth, ah(async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { status } = req.body;
  if (!['cancelled','paused','processing'].includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const { rows } = await query(
    `UPDATE engagement_orders SET status=$1, updated_at=now() WHERE id=$2 AND user_id=$3 RETURNING *`,
    [status, id, userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });

  const now = new Date().toISOString();
  if (status === 'cancelled') {
    await query(`UPDATE engagement_order_items SET status='cancelled' WHERE engagement_order_id=$1 AND status NOT IN ('completed','cancelled','failed')`, [id]);
    await query(
      `UPDATE organic_run_schedule SET status='cancelled', error_message='Order cancelled', completed_at=now()
         WHERE engagement_order_item_id IN (SELECT id FROM engagement_order_items WHERE engagement_order_id=$1)
           AND status IN ('pending','failed','started')`,
      [id]
    );
  } else if (status === 'paused') {
    await query(`UPDATE engagement_order_items SET status='paused' WHERE engagement_order_id=$1 AND status NOT IN ('completed','cancelled','failed')`, [id]);
  } else if (status === 'processing') {
    await query(`UPDATE engagement_order_items SET status='processing' WHERE engagement_order_id=$1 AND status='paused'`, [id]);
    // Cancel overdue pending runs accumulated during pause
    await query(
      `UPDATE organic_run_schedule SET status='cancelled', error_message='Skipped — order was paused', completed_at=now()
         WHERE engagement_order_item_id IN (SELECT id FROM engagement_order_items WHERE engagement_order_id=$1)
           AND status='pending' AND scheduled_at < $2`,
      [id, now]
    );
  }
  res.json({ ok: true });
}));

// PATCH /api/engagement-orders/items/:itemId/status  — per-item pause/resume/cancel
router.patch('/items/:itemId/status', requireAuth, ah(async (req, res) => {
  const { itemId } = req.params;
  const { status } = req.body;
  if (!['cancelled','paused','processing'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const now = new Date().toISOString();

  await query(`UPDATE engagement_order_items SET status=$1 WHERE id=$2`, [status, itemId]);

  if (status === 'cancelled') {
    await query(
      `UPDATE organic_run_schedule SET status='cancelled', error_message='Type cancelled', completed_at=now()
         WHERE engagement_order_item_id=$1 AND status IN ('pending','failed','started')`,
      [itemId]
    );
    // Check if all items done → cancel parent
    const { rows } = await query(`SELECT engagement_order_id FROM engagement_order_items WHERE id=$1`, [itemId]);
    if (rows[0]) {
      const { rows: rem } = await query(
        `SELECT id FROM engagement_order_items WHERE engagement_order_id=$1 AND status NOT IN ('completed','cancelled','failed')`,
        [rows[0].engagement_order_id]
      );
      if (rem.length === 0) {
        await query(`UPDATE engagement_orders SET status='cancelled' WHERE id=$1`, [rows[0].engagement_order_id]);
      }
    }
  } else if (status === 'processing') {
    await query(
      `UPDATE organic_run_schedule SET status='cancelled', error_message='Skipped — paused', completed_at=now()
         WHERE engagement_order_item_id=$1 AND status='pending' AND scheduled_at < $2`,
      [itemId, now]
    );
  }
  res.json({ ok: true });
}));

// POST /api/engagement-orders/:id/retry-failed
router.post('/:id/retry-failed', requireAuth, ah(async (req, res) => {
  const { id } = req.params;
  const { rows } = await query(
    `UPDATE organic_run_schedule
        SET status='pending', error_message=NULL, provider_order_id=NULL,
            provider_response=NULL, provider_status=NULL, started_at=NULL,
            completed_at=NULL, retry_count=0
      WHERE engagement_order_item_id IN (SELECT id FROM engagement_order_items WHERE engagement_order_id=$1)
        AND status='failed'
    RETURNING id`,
    [id]
  );
  res.json({ count: rows.length });
}));

// POST /api/engagement-orders/runs/:runId/reschedule
router.post('/runs/:runId/reschedule', requireAuth, ah(async (req, res) => {
  const { runId } = req.params;
  const { quantity, scheduledAt } = req.body;
  const userId = req.session.userId;

  // Verify ownership
  const { rows: runRows } = await query(
    `SELECT ors.*, eoi.price AS price_per_unit, eo.user_id
       FROM organic_run_schedule ors
       JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
       JOIN engagement_orders eo ON eo.id = eoi.engagement_order_id
      WHERE ors.id = $1 AND eo.user_id = $2`,
    [runId, userId]
  );
  if (!runRows[0]) return res.status(404).json({ error: 'Run not found' });

  const run = runRows[0];
  const oldQty = run.quantity_to_send;
  const diff = quantity - oldQty;
  let extraCharged = 0;

  if (diff > 0 && run.price_per_unit) {
    // Charge extra from wallet
    const extraCost = (diff / 1000) * Number(run.price_per_unit);
    const { rows: w } = await query(`SELECT balance FROM wallets WHERE user_id=$1 FOR UPDATE`, [userId]);
    if (!w[0] || Number(w[0].balance) < extraCost) return res.status(400).json({ error: 'Insufficient balance' });
    await query(`UPDATE wallets SET balance=balance-$1, updated_at=now() WHERE user_id=$2`, [extraCost, userId]);
    extraCharged = extraCost;
  }

  await query(
    `UPDATE organic_run_schedule SET quantity_to_send=$1, base_quantity=$1, scheduled_at=$2, status='pending',
        error_message=NULL, provider_order_id=NULL, started_at=NULL, completed_at=NULL, retry_count=0
      WHERE id=$3`,
    [quantity, scheduledAt, runId]
  );
  res.json({ success: true, extra_charged: extraCharged });
}));

export default router;
