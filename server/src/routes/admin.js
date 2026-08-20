import express from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ah, validate, requireAdmin } from '../middleware/auth.js';
import { fetchProviderBalance, providerConfigured } from '../provider.js';

const router = express.Router();
router.use(requireAdmin);

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

router.get(
  '/stats',
  ah(async (_req, res) => {
    const { rows } = await query(`
      SELECT
        (SELECT count(*)::int FROM users)                                        AS users,
        (SELECT count(*)::int FROM orders)                                       AS orders,
        (SELECT count(*)::int FROM orders WHERE status IN ('pending','processing')) AS open_orders,
        (SELECT count(*)::int FROM services WHERE is_active)                     AS services,
        (SELECT COALESCE(sum(balance),0)  FROM wallets)                          AS wallet_total,
        (SELECT COALESCE(sum(charge),0)   FROM orders WHERE status <> 'failed')  AS revenue
    `);
    let provider = null;
    try {
      provider = await fetchProviderBalance();
    } catch {
      provider = null;
    }
    res.json({ ...rows[0], providerConfigured, providerBalance: provider });
  })
);

router.get(
  '/users',
  ah(async (_req, res) => {
    const { rows } = await query(`
      SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at,
             COALESCE(w.balance,0) AS balance,
             COALESCE(w.total_deposited,0) AS total_deposited,
             COALESCE(w.total_spent,0) AS total_spent
        FROM users u LEFT JOIN wallets w ON w.user_id = u.id
       ORDER BY u.created_at DESC LIMIT 500
    `);
    res.json({ users: rows });
  })
);

router.patch(
  '/users/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(z.object({ role: z.enum(['user', 'admin']).optional(), isActive: z.boolean().optional() })),
  ah(async (req, res) => {
    const { role, isActive } = req.valid;
    const { rows } = await query(
      `UPDATE users
          SET role = COALESCE($1, role),
              is_active = COALESCE($2, is_active),
              updated_at = now()
        WHERE id = $3
        RETURNING id, email, role, is_active`,
      [role ?? null, isActive ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json({ user: rows[0] });
  })
);

/** Manual balance add / subtract. Idempotent per reference. */
router.post(
  '/users/:id/balance',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(
    z.object({
      amount: z.coerce.number().refine((n) => n !== 0, 'amount cannot be zero'),
      note: z.string().trim().max(200).optional(),
      reference: z.string().trim().min(4).max(120).optional(),
    })
  ),
  ah(async (req, res) => {
    const { amount, note, reference } = req.valid;
    const userId = req.params.id;

    const result = await withTx(async (client) => {
      const w = await client.query(
        'SELECT balance, total_deposited FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      if (!w.rows[0]) {
        const e = new Error('Wallet not found');
        e.status = 404;
        throw e;
      }
      const newBalance = round4(Number(w.rows[0].balance) + amount);
      if (newBalance < 0) {
        const e = new Error('Resulting balance would be negative');
        e.status = 400;
        throw e;
      }
      const totalDeposited =
        amount > 0 ? round4(Number(w.rows[0].total_deposited) + amount) : Number(w.rows[0].total_deposited);

      await client.query(
        'UPDATE wallets SET balance = $1, total_deposited = $2, updated_at = now() WHERE user_id = $3',
        [newBalance, totalDeposited, userId]
      );
      const txn = await client.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, reference, description)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          userId,
          amount > 0 ? 'deposit' : 'adjustment',
          amount,
          newBalance,
          reference || null,
          note || `Manual ${amount > 0 ? 'credit' : 'debit'} by admin`,
        ]
      );
      return { newBalance, duplicate: txn.rowCount === 0 };
    });

    res.json(result);
  })
);

const serviceSchema = z.object({
  platform: z.enum(['instagram', 'tiktok', 'youtube', 'telegram', 'facebook']),
  category: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).default(''),
  pricePer1k: z.coerce.number().min(0),
  minQuantity: z.coerce.number().int().min(1),
  maxQuantity: z.coerce.number().int().min(1),
  providerServiceId: z.string().trim().max(80).optional().nullable(),
  isActive: z.boolean().default(true),
});

router.get(
  '/services',
  ah(async (_req, res) => {
    const { rows } = await query('SELECT * FROM services ORDER BY platform, category, name');
    res.json({ services: rows });
  })
);

router.post(
  '/services',
  validate(serviceSchema),
  ah(async (req, res) => {
    const s = req.valid;
    const { rows } = await query(
      `INSERT INTO services (platform, category, name, description, price_per_1k,
                             min_quantity, max_quantity, provider_service_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [s.platform, s.category, s.name, s.description, s.pricePer1k, s.minQuantity, s.maxQuantity,
       s.providerServiceId || null, s.isActive]
    );
    res.status(201).json({ service: rows[0] });
  })
);

router.patch(
  '/services/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(serviceSchema.partial()),
  ah(async (req, res) => {
    const s = req.valid;
    const { rows } = await query(
      `UPDATE services SET
         platform = COALESCE($1, platform),
         category = COALESCE($2, category),
         name = COALESCE($3, name),
         description = COALESCE($4, description),
         price_per_1k = COALESCE($5, price_per_1k),
         min_quantity = COALESCE($6, min_quantity),
         max_quantity = COALESCE($7, max_quantity),
         provider_service_id = COALESCE($8, provider_service_id),
         is_active = COALESCE($9, is_active),
         updated_at = now()
       WHERE id = $10 RETURNING *`,
      [s.platform ?? null, s.category ?? null, s.name ?? null, s.description ?? null,
       s.pricePer1k ?? null, s.minQuantity ?? null, s.maxQuantity ?? null,
       s.providerServiceId ?? null, s.isActive ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Service not found' });
    res.json({ service: rows[0] });
  })
);

router.get(
  '/orders',
  validate(
    z.object({
      status: z
        .enum(['all', 'pending', 'processing', 'completed', 'partial', 'cancelled', 'failed'])
        .default('all'),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
    'query'
  ),
  ah(async (req, res) => {
    const { rows } = await query(
      `SELECT o.*, u.email, s.name AS service_name, s.platform
         FROM orders o
         JOIN users u ON u.id = o.user_id
         JOIN services s ON s.id = o.service_id
        WHERE ($1 = 'all' OR o.status = $1)
        ORDER BY o.created_at DESC LIMIT $2`,
      [req.valid.status, req.valid.limit]
    );
    res.json({ orders: rows });
  })
);

router.patch(
  '/orders/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(
    z.object({
      status: z.enum(['pending', 'processing', 'completed', 'partial', 'cancelled', 'failed']),
      refund: z.boolean().default(false),
    })
  ),
  ah(async (req, res) => {
    const { status, refund } = req.valid;
    const out = await withTx(async (client) => {
      const o = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      const order = o.rows[0];
      if (!order) {
        const e = new Error('Order not found');
        e.status = 404;
        throw e;
      }
      await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [
        status,
        order.id,
      ]);

      if (refund && ['cancelled', 'failed'].includes(status)) {
        const w = await client.query(
          'SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE',
          [order.user_id]
        );
        const newBalance = round4(Number(w.rows[0].balance) + Number(order.charge));
        await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [
          newBalance,
          order.user_id,
        ]);
        const t = await client.query(
          `INSERT INTO transactions (user_id, type, amount, balance_after, order_id, reference, description)
           VALUES ($1,'refund',$2,$3,$4,$5,'Admin refund')
           ON CONFLICT DO NOTHING RETURNING id`,
          [order.user_id, Number(order.charge), newBalance, order.id, `refund:${order.id}`]
        );
        return { status, refunded: t.rowCount > 0 };
      }
      return { status, refunded: false };
    });
    res.json(out);
  })
);

export default router;
