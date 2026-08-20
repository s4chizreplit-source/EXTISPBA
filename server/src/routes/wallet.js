import express from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { ah, validate, requireAuth } from '../middleware/auth.js';

const router = express.Router();

router.get(
  '/',
  requireAuth,
  ah(async (req, res) => {
    const { rows } = await query(
      `SELECT balance, total_deposited, total_spent FROM wallets WHERE user_id = $1`,
      [req.session.userId]
    );
    const w = rows[0] || { balance: 0, total_deposited: 0, total_spent: 0 };
    res.json({
      balance: Number(w.balance),
      totalDeposited: Number(w.total_deposited),
      totalSpent: Number(w.total_spent),
    });
  })
);

router.get(
  '/transactions',
  requireAuth,
  validate(
    z.object({
      type: z.enum(['all', 'deposit', 'order', 'refund', 'adjustment']).default('all'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    'query'
  ),
  ah(async (req, res) => {
    const { type, limit } = req.valid;
    const { rows } = await query(
      `SELECT id, type, amount, balance_after, description, reference, order_id, created_at
         FROM transactions
        WHERE user_id = $1 AND ($2 = 'all' OR type = $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [req.session.userId, type, limit]
    );
    res.json({ transactions: rows });
  })
);

export default router;
