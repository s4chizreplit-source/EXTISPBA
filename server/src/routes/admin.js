import express from 'express';
import { z } from 'zod';
import { query, withTx } from '../db.js';
import { ah, validate, requireAdmin } from '../middleware/auth.js';
import { fetchProviderBalance, providerConfigured } from '../provider.js';
import { seedAllData } from '../seeds/seedAllData.js';

const router = express.Router();
router.use(requireAdmin);

const INR_RATE = 83.5;

function round4(n) {
  return Math.round(Number(n) * 10000) / 10000;
}

router.get(
  '/stats',
  ah(async (_req, res) => {
    const { rows } = await query(`
      WITH deposit_baseline AS (
        SELECT
          ps.funds_added_baseline_inr,
          ps.funds_added_baseline_count,
          ps.funds_added_baseline_at
        FROM (SELECT 1) singleton
        LEFT JOIN platform_settings ps ON ps.id = 'global'
      ),
      deposit_rollup AS (
        SELECT
          b.funds_added_baseline_inr,
          b.funds_added_baseline_count,
          b.funds_added_baseline_at,
          COALESCE(
            SUM(t.amount) FILTER (
              WHERE b.funds_added_baseline_at IS NULL
                 OR t.created_at > b.funds_added_baseline_at
            ),
            0
          ) AS deposits_after_baseline,
          COUNT(t.id) FILTER (
            WHERE b.funds_added_baseline_at IS NULL
               OR t.created_at > b.funds_added_baseline_at
          )::int AS deposit_count_after_baseline,
          COALESCE(
            SUM(t.amount) FILTER (
              WHERE t.created_at >= GREATEST(
                CURRENT_DATE::timestamptz,
                COALESCE(b.funds_added_baseline_at, CURRENT_DATE::timestamptz)
              )
            ),
            0
          ) AS deposits_today
        FROM deposit_baseline b
        LEFT JOIN transactions t
          ON t.type = 'deposit'
         AND t.status = 'completed'
        GROUP BY
          b.funds_added_baseline_inr,
          b.funds_added_baseline_count,
          b.funds_added_baseline_at
      )
      SELECT
        (SELECT count(*)::int FROM auth_users)                                                      AS user_count,
        (SELECT count(*)::int FROM orders)                                                          AS total_orders,
        (SELECT count(*)::int FROM orders WHERE status IN ('pending','processing'))                 AS open_orders,
        (SELECT count(*)::int FROM services WHERE is_active)                                        AS service_count,
        (SELECT COALESCE(sum(balance),0)            FROM wallets)                                   AS total_wallet_balance,
        (SELECT COALESCE(sum(price),0)              FROM orders WHERE status <> 'failed')           AS total_revenue,
        (
          CASE
            WHEN dr.funds_added_baseline_at IS NULL
              THEN dr.deposits_after_baseline * $1
            ELSE dr.funds_added_baseline_inr + (dr.deposits_after_baseline * $1)
          END
        )                                                                                           AS total_deposits_inr,
        (
          CASE
            WHEN dr.funds_added_baseline_at IS NULL
              THEN dr.deposits_after_baseline
            ELSE (dr.funds_added_baseline_inr / $1) + dr.deposits_after_baseline
          END
        )                                                                                           AS total_deposits,
        (COALESCE(dr.funds_added_baseline_count, 0) + dr.deposit_count_after_baseline)::int          AS deposits_count,
        dr.deposits_today                                                                           AS deposits_today,
        (dr.deposits_today * $1)                                                                    AS deposits_today_inr,
        (SELECT global_markup_percent               FROM platform_settings WHERE id='global')       AS markup,
        (SELECT maintenance_mode                    FROM platform_settings WHERE id='global')       AS maintenance_mode
      FROM deposit_rollup dr
    `, [INR_RATE]);
    let provider = null;
    try { provider = await fetchProviderBalance(); } catch { provider = null; }
    res.json({ ...rows[0], providerConfigured, providerBalance: provider });
  })
);

// Platform settings
router.get('/platform-settings', ah(async (_req, res) => {
  const { rows } = await query(`SELECT * FROM platform_settings WHERE id='global'`);
  res.json(rows[0] || { id: 'global', global_markup_percent: 0, maintenance_mode: false });
}));

router.patch('/platform-settings', ah(async (req, res) => {
  const { global_markup_percent, maintenance_mode } = req.body;
  const { rows } = await query(
    `UPDATE platform_settings
        SET global_markup_percent = COALESCE($1, global_markup_percent),
            maintenance_mode      = COALESCE($2, maintenance_mode),
            updated_at            = now()
      WHERE id = 'global' RETURNING *`,
    [global_markup_percent ?? null, maintenance_mode ?? null]
  );
  res.json(rows[0]);
}));

// Providers list (for dropdown)
router.get('/providers', ah(async (_req, res) => {
  const { rows } = await query(`SELECT id, name, api_url FROM providers WHERE is_active = true ORDER BY name`);
  res.json(rows);
}));

// Provider accounts CRUD
router.get('/provider-accounts', ah(async (_req, res) => {
  const { rows } = await query(
    `SELECT * FROM provider_accounts ORDER BY provider_id, priority ASC`
  );
  res.json(rows);
}));

router.post('/provider-accounts', ah(async (req, res) => {
  const { provider_id, name, api_key, api_url, priority, is_active, delivery_multiplier } = req.body;
  const { rows } = await query(
    `INSERT INTO provider_accounts (provider_id, name, api_key, api_url, priority, is_active, delivery_multiplier)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [provider_id, name, api_key, api_url, priority ?? 1, is_active ?? true, delivery_multiplier ?? 1]
  );
  res.status(201).json(rows[0]);
}));

router.patch('/provider-accounts/:id', ah(async (req, res) => {
  const { name, api_key, api_url, priority, is_active, delivery_multiplier } = req.body;
  const { rows } = await query(
    `UPDATE provider_accounts
        SET name               = COALESCE($1, name),
            api_key            = COALESCE($2, api_key),
            api_url            = COALESCE($3, api_url),
            priority           = COALESCE($4, priority),
            is_active          = COALESCE($5, is_active),
            delivery_multiplier= COALESCE($6, delivery_multiplier),
            updated_at         = now()
      WHERE id = $7 RETURNING *`,
    [name??null, api_key??null, api_url??null, priority??null, is_active??null, delivery_multiplier??null, req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
}));

router.delete('/provider-accounts/:id', ah(async (req, res) => {
  const id = req.params.id;
  await withTx(async (client) => {
    const acct = await client.query(`SELECT * FROM provider_accounts WHERE id=$1`, [id]);
    if (!acct.rows[0]) { const e = new Error('Not found'); e.status = 404; throw e; }
    const { provider_id } = acct.rows[0];

    // Nullify FK refs
    await client.query(`UPDATE organic_run_schedule SET provider_account_id=NULL WHERE provider_account_id=$1`, [id]);
    await client.query(`DELETE FROM service_provider_mapping WHERE provider_account_id=$1`, [id]);
    await client.query(`DELETE FROM provider_accounts WHERE id=$1`, [id]);

    // If no accounts remain for this provider, clean up services + provider
    const rem = await client.query(`SELECT id FROM provider_accounts WHERE provider_id=$1 LIMIT 1`, [provider_id]);
    if (!rem.rows.length) {
      const svcs = await client.query(`SELECT id FROM services WHERE provider_id=$1`, [provider_id]);
      if (svcs.rows.length) {
        const ids = svcs.rows.map(r => r.id);
        await client.query(`UPDATE bundle_items SET service_id=NULL WHERE service_id=ANY($1)`, [ids]);
        await client.query(`UPDATE engagement_order_items SET service_id=NULL WHERE service_id=ANY($1)`, [ids]);
        await client.query(`DELETE FROM service_provider_mapping WHERE service_id=ANY($1)`, [ids]);
        await client.query(`DELETE FROM services WHERE id=ANY($1)`, [ids]);
      }
      await client.query(`DELETE FROM providers WHERE id=$1`, [provider_id]);
    }
  });
  res.json({ ok: true });
}));

// Balance check for one provider account
router.post('/provider-accounts/:id/check-balance', ah(async (req, res) => {
  const { rows } = await query(`SELECT * FROM provider_accounts WHERE id=$1`, [req.params.id]);
  const acct = rows[0];
  if (!acct) return res.status(404).json({ error: 'Not found' });

  try {
    const body = new URLSearchParams({ key: acct.api_key, action: 'balance' });
    const r = await fetch(acct.api_url, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(), signal: AbortSignal.timeout(15000),
    });
    const data = await r.json();
    const balance = Number(data.balance ?? data.funds ?? 0);
    const currency = data.currency ?? 'USD';
    await query(
      `UPDATE provider_accounts SET balance=$1, balance_currency=$2, balance_checked_at=now(), last_balance_error=NULL WHERE id=$3`,
      [balance, currency, acct.id]
    );
    res.json({ balance, currency });
  } catch (e) {
    await query(`UPDATE provider_accounts SET last_balance_error=$1, balance_checked_at=now() WHERE id=$2`, [e.message, acct.id]);
    res.status(502).json({ error: e.message });
  }
}));

router.get(
  '/users',
  ah(async (_req, res) => {
    const { rows } = await query(`
      SELECT u.id, u.email, u.full_name, u.role, u.is_active, u.created_at,
             COALESCE(w.balance,0) AS balance,
             COALESCE(w.total_deposited,0) AS total_deposited,
             COALESCE(w.total_spent,0) AS total_spent
        FROM auth_users u LEFT JOIN wallets w ON w.user_id = u.id
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
      `UPDATE auth_users
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
      if (reference) {
        const existing = await client.query(
          'SELECT id FROM transactions WHERE payment_reference = $1 LIMIT 1',
          [reference]
        );
        if (existing.rowCount) {
          return { newBalance: Number(w.rows[0].balance), duplicate: true };
        }
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
        `INSERT INTO transactions
           (user_id, type, amount, balance_after, payment_reference, description, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'completed')
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
      return { newBalance, duplicate: false };
    });

    res.json(result);
  })
);

// Aligned with the migrated `services` schema (price, provider_service_id,
// speed, quality, drip_feed_enabled). Accepts both the new field names and the
// legacy camelCase names for backward compatibility.
const serviceSchema = z
  .object({
    provider_id: z.string().trim().max(120).optional().nullable(),
    provider_service_id: z.string().trim().max(120).optional().nullable(),
    providerServiceId: z.string().trim().max(120).optional().nullable(),
    category: z.string().trim().min(1).max(120).optional(),
    name: z.string().trim().min(1).max(300).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    price: z.coerce.number().min(0).optional(),
    pricePer1k: z.coerce.number().min(0).optional(),
    min_quantity: z.coerce.number().int().min(1).optional(),
    minQuantity: z.coerce.number().int().min(1).optional(),
    max_quantity: z.coerce.number().int().min(1).optional(),
    maxQuantity: z.coerce.number().int().min(1).optional(),
    speed: z.string().trim().max(40).optional().nullable(),
    quality: z.string().trim().max(40).optional().nullable(),
    drip_feed_enabled: z.boolean().optional(),
    is_active: z.boolean().optional(),
    isActive: z.boolean().optional(),
  })
  .passthrough();

/** Normalise a validated service payload into DB column values. */
function normalizeServiceInput(s) {
  return {
    provider_id: s.provider_id ?? null,
    provider_service_id: s.provider_service_id ?? s.providerServiceId ?? null,
    category: s.category ?? null,
    name: s.name ?? null,
    description: s.description ?? null,
    price: s.price ?? s.pricePer1k ?? null,
    min_quantity: s.min_quantity ?? s.minQuantity ?? null,
    max_quantity: s.max_quantity ?? s.maxQuantity ?? null,
    speed: s.speed ?? null,
    quality: s.quality ?? null,
    drip_feed_enabled: s.drip_feed_enabled ?? null,
    is_active: s.is_active ?? s.isActive ?? null,
  };
}

router.get(
  '/services',
  ah(async (_req, res) => {
    const { rows } = await query('SELECT * FROM services ORDER BY category, name');
    res.json({ services: rows });
  })
);

router.post(
  '/services',
  validate(serviceSchema),
  ah(async (req, res) => {
    const v = normalizeServiceInput(req.valid);
    if (!v.name || !v.category) {
      return res.status(400).json({ error: 'name and category are required' });
    }
    const { rows } = await query(
      `INSERT INTO services (provider_id, provider_service_id, name, category, description,
                             price, min_quantity, max_quantity, speed, quality,
                             drip_feed_enabled, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        v.provider_id,
        v.provider_service_id,
        v.name,
        v.category,
        v.description,
        v.price ?? 0,
        v.min_quantity ?? 1,
        v.max_quantity ?? 100000,
        v.speed ?? 'medium',
        v.quality ?? 'standard',
        v.drip_feed_enabled ?? true,
        v.is_active ?? true,
      ]
    );
    res.status(201).json({ service: rows[0] });
  })
);

router.patch(
  '/services/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  validate(serviceSchema.partial()),
  ah(async (req, res) => {
    const v = normalizeServiceInput(req.valid);
    const { rows } = await query(
      `UPDATE services SET
         provider_id         = COALESCE($1, provider_id),
         provider_service_id = COALESCE($2, provider_service_id),
         category            = COALESCE($3, category),
         name                = COALESCE($4, name),
         description         = COALESCE($5, description),
         price               = COALESCE($6, price),
         min_quantity        = COALESCE($7, min_quantity),
         max_quantity        = COALESCE($8, max_quantity),
         speed               = COALESCE($9, speed),
         quality             = COALESCE($10, quality),
         drip_feed_enabled   = COALESCE($11, drip_feed_enabled),
         is_active           = COALESCE($12, is_active),
         updated_at          = now()
       WHERE id = $13 RETURNING *`,
      [
        v.provider_id,
        v.provider_service_id,
        v.category,
        v.name,
        v.description,
        v.price,
        v.min_quantity,
        v.max_quantity,
        v.speed,
        v.quality,
        v.drip_feed_enabled,
        v.is_active,
        req.params.id,
      ]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Service not found' });
    res.json({ service: rows[0] });
  })
);

// ── DELETE /services/:id ──────────────────────────────────────────────────
// Detaches all FK references then deletes the service.
router.delete(
  '/services/:id',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  ah(async (req, res) => {
    const id = req.params.id;
    const out = await withTx(async (client) => {
      const svc = await client.query('SELECT id FROM services WHERE id = $1', [id]);
      if (!svc.rows[0]) {
        const e = new Error('Service not found');
        e.status = 404;
        throw e;
      }
      await client.query('UPDATE bundle_items SET service_id = NULL WHERE service_id = $1', [id]);
      await client.query('UPDATE engagement_order_items SET service_id = NULL WHERE service_id = $1', [id]);
      await client.query('UPDATE orders SET service_id = NULL WHERE service_id = $1', [id]);
      await client.query('DELETE FROM service_provider_mapping WHERE service_id = $1', [id]);
      await client.query('DELETE FROM services WHERE id = $1', [id]);
      return { ok: true };
    });
    res.json(out);
  })
);

// ── POST /services/sync-prices ────────────────────────────────────────────
// Pulls live per-1000 rates from each service's mapped provider account and
// updates services.price. Never returns provider API keys.
router.post(
  '/services/sync-prices',
  ah(async (_req, res) => {
    // Global markup applied to raw provider cost.
    const { rows: ps } = await query(
      `SELECT COALESCE(global_markup_percent, 0) AS markup FROM platform_settings WHERE id = 'global'`
    );
    const markup = 1 + Number(ps[0]?.markup ?? 0) / 100;

    // Group mapped services by provider account so we fetch each account once.
    const { rows: maps } = await query(
      `SELECT m.service_id, m.provider_service_id, m.provider_account_id,
              pa.api_url, pa.api_key
         FROM service_provider_mapping m
         JOIN provider_accounts pa ON pa.id = m.provider_account_id
        WHERE m.is_active = true
          AND pa.is_active = true
          AND NULLIF(TRIM(pa.api_key), '') IS NOT NULL
          AND NULLIF(TRIM(pa.api_url), '') IS NOT NULL
        ORDER BY m.service_id, m.sort_order`
    );

    // Cache of provider services list keyed by account id.
    const listCache = new Map();
    async function fetchList(acct) {
      if (listCache.has(acct.provider_account_id)) return listCache.get(acct.provider_account_id);
      let list = [];
      try {
        const body = new URLSearchParams({ key: acct.api_key, action: 'services' });
        const r = await fetch(acct.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(30000),
        });
        const text = await r.text();
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        list = [];
      }
      listCache.set(acct.provider_account_id, list);
      return list;
    }

    // Only use the first (highest priority) mapping per service.
    const seen = new Set();
    let updated = 0;
    const errors = [];
    for (const m of maps) {
      if (seen.has(m.service_id)) continue;
      seen.add(m.service_id);
      try {
        const list = await fetchList(m);
        const match = list.find((s) => String(s.service ?? s.id) === String(m.provider_service_id));
        if (!match) continue;
        const rate = parseFloat(match.rate ?? match.price ?? 0);
        if (!(rate > 0)) continue;
        const price = round4((rate / 1000) * markup);
        const upd = await query(
          `UPDATE services SET price = $1, updated_at = now() WHERE id = $2`,
          [price, m.service_id]
        );
        if (upd.rowCount > 0) updated += 1;
      } catch (e) {
        errors.push(String(e.message || e));
      }
    }

    res.json({ updated, checked: seen.size, errors });
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
      `SELECT o.*, au.email,
              s.name AS service_name, s.category
         FROM orders o
         JOIN auth_users au ON au.id = o.user_id
         LEFT JOIN services s ON s.id = o.service_id
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
        const refundAmount = Number(order.price);
        // Idempotency: skip if a refund for this order already exists.
        const existing = await client.query(
          `SELECT id FROM transactions WHERE order_id = $1 AND type = 'refund' LIMIT 1`,
          [order.id]
        );
        if (existing.rows[0]) {
          return { status, refunded: false };
        }
        const newBalance = round4(Number(w.rows[0].balance) + refundAmount);
        await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [
          newBalance,
          order.user_id,
        ]);
        const t = await client.query(
          `INSERT INTO transactions (user_id, type, amount, balance_after, order_id, status, description)
           VALUES ($1,'refund',$2,$3,$4,'completed','Admin refund')
           RETURNING id`,
          [order.user_id, refundAmount, newBalance, order.id]
        );
        return { status, refunded: t.rowCount > 0 };
      }
      return { status, refunded: false };
    });
    res.json(out);
  })
);

// ── POST /orders/:id/cancel ───────────────────────────────────────────────
// Cancels an order and refunds the value of undelivered quantity.
// Atomic + idempotent: a completed order or one already carrying a refund
// transaction is never re-credited.
router.post(
  '/orders/:id/cancel',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  ah(async (req, res) => {
    const out = await withTx(async (client) => {
      const o = await client.query('SELECT * FROM orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      const order = o.rows[0];
      if (!order) {
        const e = new Error('Order not found');
        e.status = 404;
        throw e;
      }
      if (['cancelled', 'completed', 'failed'].includes(order.status)) {
        return { ok: true, alreadyResolved: true, status: order.status, refundAmount: 0, refundedQuantity: 0 };
      }

      // Cancel any not-yet-dispatched organic runs for this order and total up
      // the quantity that will never be delivered.
      const runs = await client.query(
        `UPDATE organic_run_schedule
            SET status = 'cancelled', completed_at = now()
          WHERE order_id = $1
            AND status IN ('pending', 'started')
          RETURNING quantity_to_send`,
        [order.id]
      );
      const cancelledRunQty = runs.rows.reduce((s, r) => s + Number(r.quantity_to_send || 0), 0);

      // Determine refundable quantity. For organic orders use the cancelled run
      // quantity; otherwise refund the undelivered portion of the whole order.
      const delivered = Math.max(0, Number(order.quantity || 0) - Number(order.remains ?? order.quantity ?? 0));
      const refundedQuantity = order.is_organic_mode
        ? cancelledRunQty
        : Math.max(0, Number(order.quantity || 0) - delivered);

      const totalQty = Number(order.quantity || 0);
      const unitPrice = totalQty > 0 ? Number(order.price) / totalQty : 0;
      const refundAmount = round4(unitPrice * refundedQuantity);

      await client.query('UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', [
        'cancelled',
        order.id,
      ]);

      // Idempotent refund: only credit once per order.
      const existing = await client.query(
        `SELECT id FROM transactions WHERE order_id = $1 AND type = 'refund' LIMIT 1`,
        [order.id]
      );
      if (existing.rows[0] || refundAmount <= 0) {
        return { ok: true, status: 'cancelled', refundAmount: existing.rows[0] ? 0 : refundAmount, refundedQuantity };
      }

      const w = await client.query('SELECT balance FROM wallets WHERE user_id = $1 FOR UPDATE', [
        order.user_id,
      ]);
      if (!w.rows[0]) {
        return { ok: true, status: 'cancelled', refundAmount: 0, refundedQuantity };
      }
      const newBalance = round4(Number(w.rows[0].balance) + refundAmount);
      await client.query('UPDATE wallets SET balance = $1, updated_at = now() WHERE user_id = $2', [
        newBalance,
        order.user_id,
      ]);
      await client.query(
        `INSERT INTO transactions (user_id, type, amount, balance_after, order_id, status, description)
         VALUES ($1,'refund',$2,$3,$4,'completed',$5)`,
        [order.user_id, refundAmount, newBalance, order.id, `Order cancelled — refund ${refundedQuantity} units`]
      );
      return { ok: true, status: 'cancelled', refundAmount, refundedQuantity };
    });
    res.json(out);
  })
);

// ── GET /orders/:id/runs ──────────────────────────────────────────────────
router.get(
  '/orders/:id/runs',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  ah(async (req, res) => {
    const { rows } = await query(
      `SELECT id, order_id, run_number, scheduled_at, quantity_to_send, base_quantity,
              variance_applied, status, provider_order_id, provider_status,
              provider_remains, provider_start_count, error_message,
              started_at, completed_at, created_at
         FROM organic_run_schedule
        WHERE order_id = $1
        ORDER BY run_number ASC`,
      [req.params.id]
    );
    res.json({ runs: rows });
  })
);

// ── POST /service-provider-mappings/verify ────────────────────────────────
// Confirms a provider_service_id exists on the given provider account.
// Never returns the provider API key.
router.post(
  '/service-provider-mappings/verify',
  ah(async (req, res) => {
    const { provider_account_id, provider_service_id } = req.body || {};
    if (!provider_account_id || !provider_service_id) {
      return res.status(400).json({ error: 'provider_account_id and provider_service_id required' });
    }
    const { rows } = await query(
      `SELECT pa.id, pa.name, pa.api_url, pa.api_key, pa.provider_id
         FROM provider_accounts pa WHERE pa.id = $1`,
      [provider_account_id]
    );
    const acct = rows[0];
    if (!acct) return res.status(404).json({ error: 'Provider account not found' });
    if (!acct.api_url || !acct.api_key) {
      return res.json({ verified: false, provider: acct.name, error: 'Account has no API credentials' });
    }

    try {
      const body = new URLSearchParams({ key: acct.api_key, action: 'services' });
      const r = await fetch(acct.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: AbortSignal.timeout(20000),
      });
      const text = await r.text();
      const list = JSON.parse(text);
      if (!Array.isArray(list)) {
        return res.json({ verified: false, provider: acct.name, error: 'Provider returned unexpected format' });
      }
      const match = list.find((s) => String(s.service ?? s.id) === String(provider_service_id));
      if (!match) {
        return res.json({ verified: false, provider: acct.name, error: 'Service ID not found on provider' });
      }
      return res.json({
        verified: true,
        provider: acct.name,
        service: {
          id: String(match.service ?? match.id),
          name: match.name || `Service ${provider_service_id}`,
          rate: Number(match.rate ?? match.price ?? 0),
          min: Number(match.min ?? 0),
          max: Number(match.max ?? 0),
        },
      });
    } catch (e) {
      return res.json({ verified: false, provider: acct.name, error: e.message });
    }
  })
);

// ── GET /webhook-events ───────────────────────────────────────────────────
router.get(
  '/webhook-events',
  ah(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const { provider, outcome, search } = req.query;
    const where = [];
    const params = [];
    if (provider && provider !== 'all') { params.push(provider); where.push(`provider = $${params.length}`); }
    if (outcome && outcome !== 'all') { params.push(outcome); where.push(`outcome = $${params.length}`); }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      const p = `$${params.length}`;
      where.push(`(order_id ILIKE ${p} OR track_id ILIKE ${p} OR message ILIKE ${p})`);
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT id, provider, order_id, track_id, payload_hash, event_status, outcome,
              http_status, message, payload, first_seen_at, processed_at, created_at
         FROM webhook_events
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ events: rows });
  })
);

// ── GET /security-audit ───────────────────────────────────────────────────
router.get(
  '/security-audit',
  ah(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const { category, provider, search } = req.query;
    const where = [];
    const params = [];
    if (category && category !== 'all') { params.push(category); where.push(`category = $${params.length}`); }
    if (provider && provider !== 'all') { params.push(provider); where.push(`provider = $${params.length}`); }
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      const p = `$${params.length}`;
      where.push(`(reason ILIKE ${p} OR order_id ILIKE ${p} OR track_id ILIKE ${p} OR request_path ILIKE ${p} OR ip ILIKE ${p})`);
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT id, category, source, reason, provider, order_id, track_id, user_id,
              http_status, ip, user_agent, request_path, payload, metadata, created_at
         FROM security_audit_log
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ events: rows });
  })
);

// ── GET /oxapay/log ───────────────────────────────────────────────────────
router.get(
  '/oxapay/log',
  ah(async (req, res) => {
    const limit = Math.min(1000, Math.max(1, parseInt(req.query.limit, 10) || 300));
    const { source, status, search } = req.query;
    const where = [];
    const params = [];
    if (source && source !== 'all') { params.push(source); where.push(`source = $${params.length}`); }
    if (status === 'ok') where.push(`ok = true`);
    else if (status === 'error') where.push(`ok = false`);
    if (search && String(search).trim()) {
      params.push(`%${String(search).trim()}%`);
      const p = `$${params.length}`;
      where.push(`(event ILIKE ${p} OR order_id ILIKE ${p} OR message ILIKE ${p} OR provider_status ILIKE ${p})`);
    }
    params.push(limit);
    const { rows } = await query(
      `SELECT id, created_at, source, event, order_id, user_id, plan_type, purpose,
              amount_usd, provider_status, http_status, ok, message, payload
         FROM oxapay_activity_log
        ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
        ORDER BY created_at DESC
        LIMIT $${params.length}`,
      params
    );
    res.json({ events: rows });
  })
);

// ── GET /cron/status ──────────────────────────────────────────────────────
// The dispatcher runs as an in-process 15s interval (no persistent job table),
// so status is derived from the organic_run_schedule queue.
router.get(
  '/cron/status',
  ah(async (_req, res) => {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_at <= now())::int AS overdue_count,
        MIN(scheduled_at) FILTER (WHERE status = 'pending' AND scheduled_at <= now())  AS oldest_overdue,
        MAX(completed_at) FILTER (WHERE status = 'completed')                          AS last_completed_at,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '24 hours')::int AS success_24h,
        COUNT(*) FILTER (WHERE status = 'failed'    AND completed_at > now() - interval '24 hours')::int AS failed_24h
      FROM organic_run_schedule
    `);
    const r = rows[0] || {};
    const success = Number(r.success_24h || 0);
    const failed = Number(r.failed_24h || 0);
    const total = success + failed;
    res.json({
      cron: {
        jobs: [
          { id: 1, name: 'execute-all-runs', schedule: '*/15 * * * * *', frequency: 'every 15s', active: true },
        ],
        recentRuns: [],
        stats: {
          totalRuns: total,
          successCount: success,
          failedCount: failed,
          successRate: total > 0 ? Math.round((success / total) * 100) : 100,
        },
      },
      overdueCount: Number(r.overdue_count || 0),
      oldestOverdue: r.oldest_overdue || null,
      lastCompletedAt: r.last_completed_at || null,
    });
  })
);

// ── GET /queue-health ─────────────────────────────────────────────────────
router.get(
  '/queue-health',
  ah(async (_req, res) => {
    const { rows } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending' AND scheduled_at <= now())::int AS overdue_pending,
        COUNT(*) FILTER (WHERE status IN ('started','processing'))::int           AS active_started,
        COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '1 hour')::int AS completed_last_1h,
        COUNT(*) FILTER (WHERE status = 'failed'    AND completed_at > now() - interval '1 hour')::int AS failed_last_1h,
        COUNT(*) FILTER (WHERE status = 'pending')::int                           AS total_pending,
        COALESCE(AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 60)
                 FILTER (WHERE status = 'completed'
                   AND completed_at > now() - interval '1 hour'
                   AND started_at IS NOT NULL), 0)                                AS avg_completion_min
      FROM organic_run_schedule
    `);
    const prov = await query(`
      SELECT COALESCE(provider_account_name, 'Unknown') AS name,
             COUNT(*) FILTER (WHERE status IN ('started','processing'))::int AS started,
             COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > now() - interval '1 hour')::int AS completed,
             COUNT(*) FILTER (WHERE status = 'failed'    AND completed_at > now() - interval '1 hour')::int AS failed
        FROM organic_run_schedule
       WHERE provider_account_name IS NOT NULL
       GROUP BY provider_account_name
    `);
    const r = rows[0] || {};
    res.json({
      overduePending: Number(r.overdue_pending || 0),
      activeStarted: Number(r.active_started || 0),
      completedLast1h: Number(r.completed_last_1h || 0),
      failedLast1h: Number(r.failed_last_1h || 0),
      totalPending: Number(r.total_pending || 0),
      avgCompletionMin: Math.round(Number(r.avg_completion_min || 0) * 10) / 10,
      providerStats: prov.rows.map((p) => ({
        name: p.name,
        started: Number(p.started),
        completed: Number(p.completed),
        failed: Number(p.failed),
      })),
    });
  })
);

// ── GET /deposits ─────────────────────────────────────────────────────────
// Pending manual deposit requests come from the transactions table
// (type='deposit', status='pending'), joined with profiles for display.
router.get(
  '/deposits',
  ah(async (_req, res) => {
    const { rows } = await query(
      `SELECT t.id, t.user_id, t.amount, t.status, t.description,
              t.payment_method, t.payment_reference, t.created_at,
              p.email, p.full_name, p.avatar_url
         FROM transactions t
         LEFT JOIN profiles p ON p.user_id = t.user_id
        WHERE t.type = 'deposit'
          AND t.status = 'pending'
        ORDER BY t.created_at DESC
        LIMIT 500`
    );
    const deposits = rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      amount: r.amount,
      status: r.status,
      description: r.description,
      payment_method: r.payment_method,
      payment_reference: r.payment_reference,
      created_at: r.created_at,
      profiles: { email: r.email, full_name: r.full_name, avatar_url: r.avatar_url },
    }));
    res.json({ deposits });
  })
);

// ── POST /deposits/:id/approve ────────────────────────────────────────────
// Atomic + idempotent: completing a deposit credits the wallet exactly once.
router.post(
  '/deposits/:id/approve',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  ah(async (req, res) => {
    const out = await withTx(async (client) => {
      const d = await client.query(
        `SELECT * FROM transactions WHERE id = $1 AND type = 'deposit' FOR UPDATE`,
        [req.params.id]
      );
      const dep = d.rows[0];
      if (!dep) {
        const e = new Error('Deposit not found');
        e.status = 404;
        throw e;
      }
      if (dep.status === 'completed') {
        return { ok: true, alreadyProcessed: true, status: 'completed' };
      }
      if (dep.status !== 'pending') {
        const e = new Error(`Deposit is ${dep.status}, cannot approve`);
        e.status = 400;
        throw e;
      }

      const w = await client.query(
        'SELECT balance, total_deposited FROM wallets WHERE user_id = $1 FOR UPDATE',
        [dep.user_id]
      );
      if (!w.rows[0]) {
        const e = new Error('Wallet not found');
        e.status = 404;
        throw e;
      }
      const amount = Number(dep.amount);
      const newBalance = round4(Number(w.rows[0].balance) + amount);
      const newDeposited = round4(Number(w.rows[0].total_deposited) + amount);
      await client.query(
        'UPDATE wallets SET balance = $1, total_deposited = $2, updated_at = now() WHERE user_id = $3',
        [newBalance, newDeposited, dep.user_id]
      );
      await client.query(
        `UPDATE transactions SET status = 'completed', balance_after = $1 WHERE id = $2`,
        [newBalance, dep.id]
      );
      return { ok: true, status: 'completed', newBalance };
    });
    res.json(out);
  })
);

// ── POST /deposits/:id/reject ─────────────────────────────────────────────
// Idempotent: marks the pending deposit as failed. Never credits the wallet.
router.post(
  '/deposits/:id/reject',
  validate(z.object({ id: z.string().uuid() }), 'params'),
  ah(async (req, res) => {
    const out = await withTx(async (client) => {
      const d = await client.query(
        `SELECT * FROM transactions WHERE id = $1 AND type = 'deposit' FOR UPDATE`,
        [req.params.id]
      );
      const dep = d.rows[0];
      if (!dep) {
        const e = new Error('Deposit not found');
        e.status = 404;
        throw e;
      }
      if (dep.status === 'failed') return { ok: true, alreadyProcessed: true, status: 'failed' };
      if (dep.status === 'completed') {
        const e = new Error('Deposit already approved, cannot reject');
        e.status = 400;
        throw e;
      }
      await client.query(`UPDATE transactions SET status = 'failed' WHERE id = $1`, [dep.id]);
      return { ok: true, status: 'failed' };
    });
    res.json(out);
  })
);

// ── GET /chat/conversations ───────────────────────────────────────────────
router.get(
  '/chat/conversations',
  ah(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, user_id, user_email, user_name, status, last_message_at, created_at
         FROM chat_conversations
        ORDER BY last_message_at DESC NULLS LAST, created_at DESC
        LIMIT 500`
    );
    res.json({ conversations: rows });
  })
);

// ── GET /chat/messages?conversation_id=xxx ────────────────────────────────
router.get(
  '/chat/messages',
  ah(async (req, res) => {
    const conversationId = req.query.conversation_id;
    if (!conversationId) return res.status(400).json({ error: 'conversation_id required' });
    const { rows } = await query(
      `SELECT id, conversation_id, sender_id, sender_role, message, is_read, created_at
         FROM chat_messages
        WHERE conversation_id = $1
        ORDER BY created_at ASC`,
      [conversationId]
    );
    // Mark user messages as read now that admin is viewing them.
    await query(
      `UPDATE chat_messages SET is_read = true
        WHERE conversation_id = $1 AND sender_role = 'user' AND is_read = false`,
      [conversationId]
    ).catch(() => {});
    res.json({ messages: rows });
  })
);

// ── POST /chat/messages ───────────────────────────────────────────────────
router.post(
  '/chat/messages',
  ah(async (req, res) => {
    const { conversation_id, message } = req.body || {};
    if (!conversation_id || !message || !String(message).trim()) {
      return res.status(400).json({ error: 'conversation_id and message required' });
    }
    const out = await withTx(async (client) => {
      const conv = await client.query('SELECT id FROM chat_conversations WHERE id = $1', [conversation_id]);
      if (!conv.rows[0]) {
        const e = new Error('Conversation not found');
        e.status = 404;
        throw e;
      }
      const ins = await client.query(
        `INSERT INTO chat_messages (conversation_id, sender_id, sender_role, message, is_read)
         VALUES ($1, $2, 'admin', $3, true)
         RETURNING id, conversation_id, sender_id, sender_role, message, is_read, created_at`,
        [conversation_id, req.session.userId, String(message).trim()]
      );
      await client.query(
        `UPDATE chat_conversations SET last_message_at = now(), updated_at = now() WHERE id = $1`,
        [conversation_id]
      );
      return ins.rows[0];
    });
    res.status(201).json({ message: out });
  })
);

// ── Top-up planner data ───────────────────────────────────────────────────
// Pending runs represent provider spend that has not yet been dispatched.
// Provider cost = user value / (1 + markup%).
const PLAN_PENDING_STATUSES = ['pending', 'started', 'processing'];

// User value of a single run — derived from whichever parent link exists
// (regular orders via order_id, or engagement items via engagement_order_item_id).
const RUN_USER_USD = `
  CASE
    WHEN o.id IS NOT NULL AND o.quantity > 0
      THEN (o.price / o.quantity) * ors.quantity_to_send
    WHEN eoi.id IS NOT NULL AND eoi.quantity > 0
      THEN (eoi.price / eoi.quantity) * ors.quantity_to_send
    ELSE 0
  END`;

// GET /topup-plan — per provider-account pending totals.
router.get(
  '/topup-plan',
  ah(async (_req, res) => {
    const { rows: ps } = await query(
      `SELECT COALESCE(global_markup_percent, 0) AS markup FROM platform_settings WHERE id = 'global'`
    );
    const markup = Number(ps[0]?.markup ?? 0);
    const { rows } = await query(
      `WITH run_value AS (
         SELECT
           ors.provider_account_id,
           ${RUN_USER_USD} AS user_usd
         FROM organic_run_schedule ors
         LEFT JOIN orders o                ON o.id = ors.order_id
         LEFT JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
        WHERE ors.status = ANY($1)
       )
       SELECT
          pa.id                                   AS provider_account_id,
          pa.provider_id                          AS provider_id,
          pa.name                                 AS provider_name,
          COUNT(rv.provider_account_id)::int      AS pending_runs,
          COALESCE(SUM(rv.user_usd), 0)           AS pending_user_usd
        FROM provider_accounts pa
        LEFT JOIN run_value rv ON rv.provider_account_id = pa.id
       WHERE pa.is_active = true
       GROUP BY pa.id, pa.provider_id, pa.name
       ORDER BY pa.name`,
      [PLAN_PENDING_STATUSES]
    );
    const plan = rows.map((r) => ({
      provider_account_id: r.provider_account_id,
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      pending_runs: Number(r.pending_runs || 0),
      pending_user_usd: Number(r.pending_user_usd || 0),
      markup_percent: markup,
    }));
    res.json({ plan });
  })
);

// GET /topup-breakdown — per provider-account × service pending totals.
router.get(
  '/topup-breakdown',
  ah(async (_req, res) => {
    const { rows } = await query(
      `SELECT
          pa.id                                   AS provider_account_id,
          pa.provider_id                          AS provider_id,
          pa.name                                 AS provider_name,
          s.id                                    AS service_id,
          s.name                                  AS service_name,
          s.category                              AS service_category,
          COUNT(ors.id)::int                      AS pending_runs,
          COALESCE(SUM(ors.quantity_to_send), 0)::bigint AS pending_quantity,
          COALESCE(SUM(${RUN_USER_USD}), 0)       AS pending_user_usd
        FROM organic_run_schedule ors
        LEFT JOIN orders o                ON o.id = ors.order_id
        LEFT JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
        LEFT JOIN provider_accounts pa ON pa.id = ors.provider_account_id
        LEFT JOIN services s ON s.id = COALESCE(o.service_id, eoi.service_id)
       WHERE ors.status = ANY($1)
       GROUP BY pa.id, pa.provider_id, pa.name, s.id, s.name, s.category
       ORDER BY pending_user_usd DESC`,
      [PLAN_PENDING_STATUSES]
    );
    const breakdown = rows.map((r) => ({
      provider_account_id: r.provider_account_id,
      provider_id: r.provider_id,
      provider_name: r.provider_name,
      service_id: r.service_id,
      service_name: r.service_name,
      service_category: r.service_category,
      pending_runs: Number(r.pending_runs || 0),
      pending_quantity: Number(r.pending_quantity || 0),
      pending_user_usd: Number(r.pending_user_usd || 0),
    }));
    res.json({ breakdown });
  })
);

// GET /topup-users — top users by pending order value.
router.get(
  '/topup-users',
  ah(async (_req, res) => {
    const { rows } = await query(
      `WITH run_user AS (
         SELECT
           COALESCE(o.user_id, eo.user_id)           AS user_id,
           COALESCE(o.id, eo.id)                      AS parent_id,
           ${RUN_USER_USD}                            AS user_usd
         FROM organic_run_schedule ors
         LEFT JOIN orders o                ON o.id = ors.order_id
         LEFT JOIN engagement_order_items eoi ON eoi.id = ors.engagement_order_item_id
         LEFT JOIN engagement_orders eo    ON eo.id = eoi.engagement_order_id
        WHERE ors.status = ANY($1)
       )
       SELECT
          ru.user_id                                   AS user_id,
          COUNT(DISTINCT ru.parent_id)::int             AS count,
          COALESCE(SUM(ru.user_usd), 0)                 AS value,
          p.email                                       AS email,
          p.full_name                                   AS name,
          COALESCE(w.balance, 0)                        AS wallet,
          COALESCE(w.total_deposited, 0)                AS deposited,
          COALESCE(w.total_spent, 0)                    AS spent
        FROM run_user ru
        LEFT JOIN profiles p ON p.user_id = ru.user_id
        LEFT JOIN wallets  w ON w.user_id = ru.user_id
       WHERE ru.user_id IS NOT NULL
       GROUP BY ru.user_id, p.email, p.full_name, w.balance, w.total_deposited, w.total_spent
       ORDER BY value DESC
       LIMIT 5`,
      [PLAN_PENDING_STATUSES]
    );
    res.json({ users: rows });
  })
);

// ── POST /provider-accounts/check-balances ────────────────────────────────
// Live balance check across all active provider accounts. Never returns keys.
router.post(
  '/provider-accounts/check-balances',
  ah(async (_req, res) => {
    const { rows: accounts } = await query(
      `SELECT id, name, api_url, api_key FROM provider_accounts
        WHERE is_active = true
          AND NULLIF(TRIM(api_key), '') IS NOT NULL
          AND NULLIF(TRIM(api_url), '') IS NOT NULL`
    );
    const results = [];
    let checked = 0;
    for (const acct of accounts) {
      try {
        const body = new URLSearchParams({ key: acct.api_key, action: 'balance' });
        const r = await fetch(acct.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          signal: AbortSignal.timeout(15000),
        });
        const data = await r.json();
        const balance = Number(data.balance ?? data.funds ?? 0);
        const currency = data.currency ?? 'USD';
        await query(
          `UPDATE provider_accounts
              SET balance = $1, balance_currency = $2, balance_checked_at = now(),
                  last_balance_error = NULL
            WHERE id = $3`,
          [balance, currency, acct.id]
        );
        checked += 1;
        results.push({ id: acct.id, name: acct.name, balance, currency });
      } catch (e) {
        await query(
          `UPDATE provider_accounts SET last_balance_error = $1, balance_checked_at = now() WHERE id = $2`,
          [e.message, acct.id]
        );
        results.push({ id: acct.id, name: acct.name, error: e.message });
      }
    }
    res.json({ checked, results });
  })
);

// ── Manual seed trigger (one-time data import) ────────────────────────────
router.post(
  '/run-seed',
  ah(async (_req, res) => {
    console.log('[seed] Manual seed triggered via admin API');
    await seedAllData();
    const { rows } = await query(`
      SELECT
        (SELECT COUNT(*)::int FROM public.profiles)             AS profiles,
        (SELECT COUNT(*)::int FROM public.wallets)              AS wallets,
        (SELECT COUNT(*)::int FROM public.engagement_bundles)   AS bundles,
        (SELECT COUNT(*)::int FROM public.engagement_orders)    AS eng_orders
    `);
    res.json({ ok: true, counts: rows[0] });
  })
);

export default router;
