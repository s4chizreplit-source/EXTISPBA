import express from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ah, validate, requireAuth } from '../middleware/auth.js';
import { placeProviderOrder, fetchProviderStatus } from '../provider.js';

const router = express.Router();

const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'partial']);

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

/** Quote: charge = quantity / 1000 * price_per_1k */
router.post(
  '/quote',
  requireAuth,
  validate(z.object({ serviceId: z.string().uuid(), quantity: z.coerce.number().int().min(1) })),
  ah(async (req, res) => {
    const { serviceId, quantity } = req.valid;
    const { rows } = await query(
      'SELECT * FROM services WHERE id = $1 AND is_active = true',
      [serviceId]
    );
    const service = rows[0];
    if (!service) return res.status(404).json({ error: 'Service not found' });
    if (quantity < service.min_quantity || quantity > service.max_quantity) {
      return res.status(400).json({
        error: `Quantity must be between ${service.min_quantity} and ${service.max_quantity}`,
      });
    }
    res.json({ charge: round4((quantity / 1000) * Number(service.price_per_1k)) });
  })
);

router.post(
  '/',
  requireAuth,
  validate(
    z.object({
      serviceId: z.string().uuid(),
      link: z.string().trim().url().max(500),
      quantity: z.coerce.number().int().min(1).max(10_000_000),
    })
  ),
  ah(async (req, res) => {
    const { serviceId, link, quantity } = req.valid;
    const userId = req.session.userId;

    // 1) Validate + debit wallet + create order atomically.
    const created = await withTx(async (client) => {
      const svcRes = await client.query(
        'SELECT * FROM services WHERE id = $1 AND is_active = true',
        [serviceId]
      );
      const service = svcRes.rows[0];
      if (!service) {
        const e = new Error('Service not found');
        e.status = 404;
        throw e;
      }
      if (quantity < service.min_quantity || quantity > service.max_quantity) {
        const e = new Error(
          `Quantity must be between ${service.min_quantity} and ${service.max_quantity}`
        );
        e.status = 400;
        throw e;
      }

      const charge = round4((quantity / 1000) * Number(service.price_per_1k));

      const walletRes = await client.query(
        'SELECT balance, total_spent FROM wallets WHERE user_id = $1 FOR UPDATE',
        [userId]
      );
      const wallet = walletRes.rows[0];
      if (!wallet) {
        const e = new Error('Wallet not found');
        e.status = 404;
        throw e;
      }
      if (Number(wallet.balance) < charge) {
        const e = new Error('Insufficient wallet balance');
        e.status = 402;
        throw e;
      }

      const newBalance = round4(Number(wallet.balance) - charge);
      await client.query(
        `UPDATE wallets SET balance = $1, total_spent = $2, updated_at = now() WHERE user_id = $3`,
        [newBalance, round4(Number(wallet.total_spent) + charge), userId]
      );

      const orderRes = await client.query(
        `INSERT INTO orders (user_id, service_id, link, quantity, charge, status)
         VALUES ($1, $2, $3, $4, $5, 'pending') RETURNING *`,
        [userId, serviceId, link, quantity, charge]
      );
      const order = orderRes.rows[0];

      await client.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, order_id, reference, description)
         VALUES ($1, 'order', $2, $3, $4, $5, $6)`,
        [
          userId,
          -charge,
          newBalance,
          order.id,
          `order:${order.id}`,
          `${service.name} x${quantity}`,
        ]
      );

      return { order, service };
    });

    // 2) Send to provider outside the transaction; failure refunds the user.
    try {
      const { providerOrderId, raw } = await placeProviderOrder({
        providerServiceId: created.service.provider_service_id,
        link,
        quantity,
      });
      const { rows } = await query(
        `UPDATE orders
            SET status = 'processing', provider_order_id = $1, provider_response = $2, updated_at = now()
          WHERE id = $3 RETURNING *`,
        [providerOrderId, raw, created.order.id]
      );
      return res.status(201).json({ order: rows[0] });
    } catch (err) {
      await withTx(async (client) => {
        const claimed = await client.query(
          `UPDATE orders SET status = 'failed', error_message = $1, updated_at = now()
            WHERE id = $2 AND status = 'pending' RETURNING charge`,
          [String(err.message).slice(0, 500), created.order.id]
        );
        if (!claimed.rowCount) return;
        const charge = Number(claimed.rows[0].charge);
        const w = await client.query(
          'SELECT balance, total_spent FROM wallets WHERE user_id = $1 FOR UPDATE',
          [userId]
        );
        const newBalance = round4(Number(w.rows[0].balance) + charge);
        await client.query(
          `UPDATE wallets SET balance = $1, total_spent = $2, updated_at = now() WHERE user_id = $3`,
          [newBalance, round4(Math.max(0, Number(w.rows[0].total_spent) - charge)), userId]
        );
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, balance_after, order_id, reference, description)
           VALUES ($1, 'refund', $2, $3, $4, $5, 'Auto-refund: provider rejected order')
           ON CONFLICT DO NOTHING`,
          [userId, charge, newBalance, created.order.id, `refund:${created.order.id}`]
        );
      });
      return res.status(502).json({ error: `Provider error: ${err.message}`, refunded: true });
    }
  })
);

router.get(
  '/',
  requireAuth,
  validate(
    z.object({
      status: z
        .enum(['all', 'pending', 'processing', 'completed', 'partial', 'cancelled', 'failed'])
        .default('all'),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    'query'
  ),
  ah(async (req, res) => {
    const { status, limit } = req.valid;
    const { rows } = await query(
      `SELECT o.*, s.name AS service_name, s.platform
         FROM orders o JOIN services s ON s.id = o.service_id
        WHERE o.user_id = $1 AND ($2 = 'all' OR o.status = $2)
        ORDER BY o.created_at DESC LIMIT $3`,
      [req.session.userId, status, limit]
    );
    res.json({ orders: rows });
  })
);

/** Live status: refreshes from the provider when the order is still open. */
router.get(
  '/:id',
  requireAuth,
  validate(z.object({ id: z.string().uuid() }), 'params'),
  ah(async (req, res) => {
    const { rows } = await query(
      `SELECT o.*, s.name AS service_name, s.platform
         FROM orders o JOIN services s ON s.id = o.service_id
        WHERE o.id = $1 AND o.user_id = $2`,
      [req.valid.id, req.session.userId]
    );
    let order = rows[0];
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (!TERMINAL.has(order.status) && order.provider_order_id) {
      try {
        const live = await fetchProviderStatus(order.provider_order_id);
        if (live) {
          const updated = await query(
            `UPDATE orders
                SET status = $1, start_count = COALESCE($2, start_count),
                    remains = $3, provider_response = $4, updated_at = now()
              WHERE id = $5 RETURNING *`,
            [live.status, live.startCount, live.remains, live.raw, order.id]
          );
          order = { ...order, ...updated.rows[0] };
        }
      } catch (err) {
        console.warn('status refresh failed:', err.message);
      }
    }
    res.json({ order });
  })
);

export default router;
