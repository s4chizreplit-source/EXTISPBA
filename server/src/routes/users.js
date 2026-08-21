/**
 * Admin user management routes.
 * Replaces get_admin_users_summary RPC + all user-action Supabase calls.
 */
import express from 'express';
import { query, withTx } from '../db.js';
import { ah, requireAdmin } from '../middleware/auth.js';
import {
  requireEngagementOrderReadiness,
} from '../middleware/engagementOrderReadiness.js';

const router = express.Router();
router.use(requireAdmin);

const INR_RATE = 83.5;

// ─── GET /api/admin/users ─────────────────────────────────────────────────
router.get('/', requireEngagementOrderReadiness, ah(async (_req, res) => {
  const { rows } = await query(`
    SELECT
      p.id,
      p.user_id,
      p.email,
      p.full_name,
      p.created_at,
      COALESCE(w.balance, 0)          AS balance,
      COALESCE(w.total_deposited, 0)  AS total_deposited,
      COALESCE(w.total_spent, 0)      AS total_spent,
      COALESCE(ur.role, 'user')       AS role,
      COUNT(DISTINCT o.id)  FILTER (WHERE o.status  IN ('pending','processing')) AS active_single_orders,
      COUNT(DISTINCT o.id)  FILTER (WHERE o.status  = 'paused')                 AS paused_single_orders,
      COUNT(DISTINCT eo.id) FILTER (WHERE eo.status IN ('pending','processing')) AS active_engagement_orders,
      COUNT(DISTINCT eo.id) FILTER (WHERE eo.status = 'paused')                 AS paused_engagement_orders
    FROM profiles p
    LEFT JOIN wallets         w  ON w.user_id  = p.user_id
    LEFT JOIN user_roles      ur ON ur.user_id = p.user_id
    LEFT JOIN orders          o  ON o.user_id  = p.user_id
    LEFT JOIN engagement_orders eo ON eo.user_id = p.user_id
    GROUP BY p.id, p.user_id, p.email, p.full_name, p.created_at,
             w.balance, w.total_deposited, w.total_spent, ur.role
    ORDER BY p.created_at DESC
  `);
  res.json(rows);
}));

// ─── POST /api/admin/users/:id/balance ───────────────────────────────────
// body: { action: 'add'|'subtract', inr_amount: number }
router.post('/:id/balance', ah(async (req, res) => {
  const { id: user_id } = req.params;
  const { action, inr_amount } = req.body;
  if (!['add', 'subtract'].includes(action) || !inr_amount || inr_amount <= 0) {
    return res.status(400).json({ error: 'action (add|subtract) and inr_amount > 0 required' });
  }

  const amount = Math.trunc((parseFloat(inr_amount) / INR_RATE) * 10000) / 10000;

  await withTx(async (client) => {
    // Read live balance
    const { rows: [w] } = await client.query(
      `SELECT balance, total_deposited FROM wallets WHERE user_id=$1`, [user_id]
    );
    const currentBalance   = Number(w?.balance         || 0);
    const currentDeposited = Number(w?.total_deposited || 0);

    const newBalance = Math.trunc(
      (action === 'add' ? currentBalance + amount : currentBalance - amount) * 10000
    ) / 10000;
    if (newBalance < 0) throw new Error('Balance cannot be negative');

    await client.query(`
      INSERT INTO wallets (user_id, balance, total_deposited)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id) DO UPDATE
        SET balance = $2,
            total_deposited = $3,
            updated_at = now()
    `, [user_id, newBalance, action === 'add' ? currentDeposited + amount : currentDeposited]);

    await client.query(`
      INSERT INTO transactions (user_id, type, amount, balance_after, description, status)
      VALUES ($1, $2, $3, $4, $5, 'completed')
    `, [
      user_id,
      action === 'add' ? 'deposit' : 'withdrawal',
      action === 'add' ? amount : -amount,
      newBalance,
      `Admin ${action === 'add' ? 'deposit' : 'withdrawal'} — ₹${parseFloat(inr_amount).toFixed(2)}`,
    ]);
  });

  res.json({ ok: true });
}));

// ─── PATCH /api/admin/users/:id/role ─────────────────────────────────────
router.patch('/:id/role', ah(async (req, res) => {
  const { id: user_id } = req.params;
  const { role } = req.body; // 'admin' | 'user'
  if (!['admin', 'user'].includes(role)) return res.status(400).json({ error: 'role must be admin or user' });
  await query(`UPDATE user_roles SET role=$1 WHERE user_id=$2`, [role, user_id]);
  res.json({ ok: true });
}));

// ─── POST /api/admin/users/:id/pause-orders ──────────────────────────────
router.post('/:id/pause-orders', requireEngagementOrderReadiness, ah(async (req, res) => {
  const { id: user_id } = req.params;
  await query(
    `UPDATE orders SET status='paused' WHERE user_id=$1 AND status IN ('pending','processing')`,
    [user_id]
  );
  await query(
    `UPDATE engagement_orders SET status='paused' WHERE user_id=$1 AND status IN ('pending','processing')`,
    [user_id]
  );
  res.json({ ok: true });
}));

// ─── POST /api/admin/users/:id/resume-orders ─────────────────────────────
router.post('/:id/resume-orders', requireEngagementOrderReadiness, ah(async (req, res) => {
  const { id: user_id } = req.params;
  const now = new Date().toISOString();

  // Cancel overdue pending runs for paused engagement orders
  const { rows: pausedEng } = await query(
    `SELECT id FROM engagement_orders WHERE user_id=$1 AND status='paused'`, [user_id]
  );
  if (pausedEng.length > 0) {
    const engIds = pausedEng.map(r => r.id);
    const { rows: items } = await query(
      `SELECT id FROM engagement_order_items WHERE engagement_order_id = ANY($1)`, [engIds]
    );
    if (items.length > 0) {
      await query(`
        UPDATE organic_run_schedule
           SET status='cancelled',
               error_message='Skipped — order was paused during this scheduled time',
               completed_at=$1
         WHERE engagement_order_item_id = ANY($2)
           AND status='pending' AND scheduled_at < $1
      `, [now, items.map(i => i.id)]);
    }
  }

  // Cancel overdue runs for paused single orders
  const { rows: pausedSingle } = await query(
    `SELECT id FROM orders WHERE user_id=$1 AND status='paused'`, [user_id]
  );
  if (pausedSingle.length > 0) {
    await query(`
      UPDATE organic_run_schedule
         SET status='cancelled',
             error_message='Skipped — order was paused during this scheduled time',
             completed_at=$1
       WHERE order_id = ANY($2) AND status='pending' AND scheduled_at < $1
    `, [now, pausedSingle.map(r => r.id)]);
  }

  await query(
    `UPDATE orders SET status='processing' WHERE user_id=$1 AND status='paused'`, [user_id]
  );
  await query(
    `UPDATE engagement_orders SET status='processing' WHERE user_id=$1 AND status='paused'`, [user_id]
  );
  res.json({ ok: true });
}));

// ─── POST /api/admin/users/:id/cancel-orders ─────────────────────────────
// body: { refund: boolean }
router.post('/:id/cancel-orders', requireEngagementOrderReadiness, ah(async (req, res) => {
  const { id: user_id } = req.params;
  const refund = req.body?.refund === true;

  // Single orders to cancel
  const { rows: singleOrders } = await query(
    `SELECT id, price FROM orders WHERE user_id=$1
       AND status NOT IN ('completed','cancelled','failed')`, [user_id]
  );
  // Engagement orders to cancel
  const { rows: engagementOrders } = await query(
    `SELECT id, total_price FROM engagement_orders WHERE user_id=$1
       AND status NOT IN ('completed','cancelled','failed')`, [user_id]
  );

  // Cancel pending runs for single orders
  for (const o of singleOrders) {
    await query(
      `UPDATE organic_run_schedule SET status='cancelled' WHERE order_id=$1 AND status='pending'`, [o.id]
    );
  }

  // Cancel runs + items for engagement orders
  for (const eo of engagementOrders) {
    const { rows: items } = await query(
      `SELECT id FROM engagement_order_items WHERE engagement_order_id=$1`, [eo.id]
    );
    for (const item of items) {
      await query(
        `UPDATE organic_run_schedule SET status='cancelled'
          WHERE engagement_order_item_id=$1 AND status='pending'`, [item.id]
      );
    }
    await query(
      `UPDATE engagement_order_items SET status='cancelled'
        WHERE engagement_order_id=$1 AND status NOT IN ('completed','cancelled','failed')`, [eo.id]
    );
  }

  // Cancel orders
  await query(
    `UPDATE orders SET status='cancelled' WHERE user_id=$1 AND status NOT IN ('completed','cancelled','failed')`,
    [user_id]
  );
  await query(
    `UPDATE engagement_orders SET status='cancelled' WHERE user_id=$1 AND status NOT IN ('completed','cancelled','failed')`,
    [user_id]
  );

  // Optional refund
  if (refund) {
    const singleTotal = singleOrders.reduce((s, o) => s + Number(o.price || 0), 0);
    const engTotal = engagementOrders.reduce((s, o) => s + Number(o.total_price || 0), 0);
    const totalRefund = singleTotal + engTotal;
    if (totalRefund > 0) {
      await withTx(async (client) => {
        const { rows: [w] } = await client.query(
          `SELECT balance FROM wallets WHERE user_id=$1`, [user_id]
        );
        const newBalance = Number(w?.balance || 0) + totalRefund;
        await client.query(
          `UPDATE wallets SET balance=$1, updated_at=now() WHERE user_id=$2`, [newBalance, user_id]
        );
        await client.query(`
          INSERT INTO transactions (user_id, type, amount, balance_after, description, status)
          VALUES ($1, 'refund', $2, $3, 'Admin cancelled all orders - refund', 'completed')
        `, [user_id, totalRefund, newBalance]);
      });
    }
  }

  res.json({ ok: true });
}));

// ─── POST /api/admin/users/:id/self-test ─────────────────────────────────
// Runs +₹1 / -₹1 wallet self-test server-side and returns step results.
router.post('/:id/self-test', ah(async (req, res) => {
  const { id: user_id } = req.params;
  const delta = Math.trunc((1 / INR_RATE) * 10000) / 10000;
  const steps = [];
  const push = (label, ok, detail) => steps.push({ label, ok, detail });
  const insertedTxIds = [];
  let b0 = null;
  let walletMutated = false;

  const cleanup = async (reason) => {
    try {
      if (walletMutated && b0 !== null) {
        await query(`UPDATE wallets SET balance=$1 WHERE user_id=$2`, [b0, user_id]);
      }
      if (insertedTxIds.length) {
        await query(`DELETE FROM transactions WHERE id = ANY($1)`, [insertedTxIds]);
      }
      push(`Rollback (${reason}) — balance restored & self-test rows removed`, true);
    } catch (ce) {
      push('Rollback FAILED — manual review needed', false, ce.message);
    }
  };

  try {
    const { rows: [w0row] } = await query(
      `SELECT balance FROM wallets WHERE user_id=$1`, [user_id]
    );
    b0 = Number(w0row?.balance || 0);
    push(`1. Initial balance = $${b0.toFixed(4)}`, true);

    const b1 = Math.trunc((b0 + delta) * 10000) / 10000;
    await query(`UPDATE wallets SET balance=$1 WHERE user_id=$2`, [b1, user_id]);
    walletMutated = true;
    push('2. Update wallet (+₹1)', true);

    const { rows: [ti1] } = await query(`
      INSERT INTO transactions (user_id, type, amount, balance_after, status, description)
      VALUES ($1, 'deposit', $2, $3, 'completed', '[ADMIN SELF-TEST] +₹1 (auto-reverted)')
      RETURNING id
    `, [user_id, delta, b1]);
    if (ti1?.id) insertedTxIds.push(ti1.id);
    push('3. Insert deposit transaction', true);

    const { rows: [w1] } = await query(`SELECT balance FROM wallets WHERE user_id=$1`, [user_id]);
    const okAdd = Math.abs(Number(w1?.balance || 0) - b1) < 0.0001;
    push(`4. Verify balance = $${b1.toFixed(4)}`, okAdd, `got $${Number(w1?.balance).toFixed(4)}`);

    const b2 = Math.trunc((b1 - delta) * 10000) / 10000;
    await query(`UPDATE wallets SET balance=$1 WHERE user_id=$2`, [b2, user_id]);
    push('5. Update wallet (-₹1)', true);

    const { rows: [ti2] } = await query(`
      INSERT INTO transactions (user_id, type, amount, balance_after, status, description)
      VALUES ($1, 'withdrawal', $2, $3, 'completed', '[ADMIN SELF-TEST] -₹1 (auto-reverted)')
      RETURNING id
    `, [user_id, -delta, b2]);
    if (ti2?.id) insertedTxIds.push(ti2.id);
    push('6. Insert withdrawal transaction', true);

    const { rows: [w2] } = await query(`SELECT balance FROM wallets WHERE user_id=$1`, [user_id]);
    const okSub = Math.abs(Number(w2?.balance || 0) - b0) < 0.0001;
    push(`7. Verify balance restored = $${b0.toFixed(4)}`, okSub, `got $${Number(w2?.balance).toFixed(4)}`);
    push(`8. Recorded ${insertedTxIds.length} self-test transaction(s) — cleaning up`, true);

    await cleanup('test complete');
  } catch (err) {
    push('ABORTED', false, err.message);
    await cleanup('error');
  }

  res.json({ steps });
}));

export default router;
