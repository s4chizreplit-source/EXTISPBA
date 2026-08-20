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

// GET /api/engagement-orders/:id  — single order detail
router.get('/:id', requireAuth, ah(async (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const { rows } = await query(
    `SELECT * FROM engagement_orders WHERE id = $1 AND user_id = $2`,
    [id, userId]
  );
  if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });

  const order = rows[0];

  const { rows: items } = await query(
    `SELECT * FROM engagement_order_items WHERE engagement_order_id = $1`,
    [id]
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

  res.json({
    ...order,
    items: items.map(item => ({ ...item, runs: runsByItem[item.id] || [] })),
  });
}));

export default router;
