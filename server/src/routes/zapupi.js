/**
 * ZapUPI payment gateway routes.
 * Replaces Supabase Edge Functions: zapupi-create-order, zapupi-sync-deposit, zapupi-webhook
 */

import express from 'express';
import { query, withTx } from '../db.js';
import { ah, requireAuth } from '../middleware/auth.js';
import { decryptAppSecret } from '../services/appSecret.js';

const router = express.Router();

const CREATE_URL  = 'https://pay.zapupi.com/api/create-order';
const STATUS_URL  = 'https://pay.zapupi.com/api/order-status';
const USD_RATE    = 83.5;
const MIN_INR     = 50;
const MAX_INR     = 100000;

async function getZapKey() {
  try {
    const { rows } = await query(
      `SELECT zapupi_api_key_ciphertext
         FROM public.platform_settings
        WHERE id = 'global'`
    );
    const encrypted = rows[0]?.zapupi_api_key_ciphertext;
    if (encrypted) return decryptAppSecret(encrypted).trim();
  } catch (error) {
    console.error('[zapupi] Stored API key could not be loaded:', error.message);
  }
  return String(process.env.ZAPUPI_API_KEY || '').trim();
}

/** POST form-encoded, then retry as JSON if needed */
async function zapCall(url, params) {
  async function attempt(mode) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': mode === 'form' ? 'application/x-www-form-urlencoded' : 'application/json' },
      body: mode === 'form' ? new URLSearchParams(params).toString() : JSON.stringify(params),
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: res.ok, status: res.status, data };
  }
  const r1 = await attempt('form');
  const ok1 = r1.ok && String(r1.data?.status || '').toLowerCase() === 'success';
  if (ok1) return r1.data;
  const r2 = await attempt('json');
  return r2.data;
}

/** Credit wallet — idempotent, atomic. Replaces the missing credit_wallet_zapupi() stored procedure. */
async function creditWallet({ userId, orderId, amountInr, txnId, utr }) {
  const amountUsd = Number((amountInr / USD_RATE).toFixed(4));

  return withTx(async (client) => {
    // Idempotency check — if already credited, skip
    const { rows: dep } = await client.query(
      `SELECT credited FROM zapupi_deposits WHERE order_id=$1 FOR UPDATE`,
      [orderId]
    );
    if (!dep[0] || dep[0].credited) return dep[0];

    // Mark deposit as credited
    await client.query(
      `UPDATE zapupi_deposits
          SET credited=true, status='success', amount_usd=$1,
              txn_id=COALESCE($2, txn_id), utr=COALESCE($3, utr),
              updated_at=now()
        WHERE order_id=$4`,
      [amountUsd, txnId || null, utr || null, orderId]
    );

    // Credit the wallet
    const { rows: [wallet] } = await client.query(
      `UPDATE wallets
          SET balance = balance + $1, updated_at = now()
        WHERE user_id = $2
        RETURNING balance`,
      [amountUsd, userId]
    );

    // Record the transaction
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, balance_after, status, description)
       VALUES ($1, 'deposit', $2, $3, 'completed', $4)
       ON CONFLICT DO NOTHING`,
      [userId, amountUsd, wallet?.balance ?? amountUsd, `ZapUPI deposit ₹${amountInr} (${orderId})`]
    );

    console.log(`[zapupi] ✅ Wallet credited $${amountUsd} (₹${amountInr}) for user ${userId}`);
    return { credited: true, amountUsd, amountInr };
  });
}

// ─── POST /api/zapupi/create-order ───────────────────────────────────────────
router.post('/create-order', requireAuth, ah(async (req, res) => {
  const ZAP_KEY = await getZapKey();
  if (!ZAP_KEY) return res.status(500).json({ error: 'ZapUPI not configured' });

  const amountInr = Math.floor(Number(req.body?.amount_inr) || 0);
  if (!amountInr || amountInr < MIN_INR)  return res.status(400).json({ error: `Minimum deposit is ₹${MIN_INR}` });
  if (amountInr > MAX_INR) return res.status(400).json({ error: `Maximum deposit is ₹${MAX_INR}` });

  const userId  = req.session.userId;
  const orderId = `zap_${userId.slice(0, 8)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // Insert pending row first (so webhook can find it)
  await query(
    `INSERT INTO zapupi_deposits (user_id, order_id, amount_inr, status) VALUES ($1,$2,$3,'pending')`,
    [userId, orderId, amountInr]
  );

  // Determine origin for redirect URLs.
  // Priority: PUBLIC_APP_URL > REPLIT_DOMAINS (production) > REPLIT_DEV_DOMAIN (dev) > request header.
  const configuredOrigin = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  const replitProdDomain = String(process.env.REPLIT_DOMAINS || '').split(',').map(d => d.trim()).find(Boolean);
  const replitDevDomain  = String(process.env.REPLIT_DEV_DOMAIN || '').trim();
  const autoOrigin = replitProdDomain
    ? `https://${replitProdDomain}`
    : replitDevDomain
      ? `https://${replitDevDomain}`
      : (req.headers.origin || req.headers.referer || '').replace(/\/$/, '');
  const origin = configuredOrigin || autoOrigin;
  if (!origin) return res.status(503).json({ error: 'Public application URL is not configured' });
  const webhookUrl = `${origin}/api/zapupi/webhook`;

  const payload = {
    zap_key: ZAP_KEY,
    order_id: orderId,
    amount: String(amountInr),
    customer_mobile: '9999999999',
    remark: `Wallet Top-up | ${userId}`,
    webhook_url: webhookUrl,
    success_url: `${origin}/wallet?deposit=success&order_id=${orderId}`,
    failed_url:  `${origin}/wallet?deposit=failed&order_id=${orderId}`,
    timeout_url: `${origin}/wallet?deposit=timeout&order_id=${orderId}`,
  };

  const data = await zapCall(CREATE_URL, payload);
  const paymentUrl = data?.payment_url || data?.data?.payment_url || data?.data?.url || data?.url;

  if (!paymentUrl) {
    await query(`UPDATE zapupi_deposits SET status='failed', raw_response=$1 WHERE order_id=$2`, [data, orderId]);
    return res.status(502).json({ error: data?.message || data?.msg || data?.error || 'No payment URL returned' });
  }

  await query(
    `UPDATE zapupi_deposits SET payment_url=$1, txn_id=$2, raw_response=$3 WHERE order_id=$4`,
    [paymentUrl, data?.txn_id || data?.order_id || null, data, orderId]
  );

  res.json({ success: true, payment_url: paymentUrl, order_id: orderId, amount_inr: amountInr });
}));

// ─── POST /api/zapupi/sync-deposit ───────────────────────────────────────────
router.post('/sync-deposit', requireAuth, ah(async (req, res) => {
  const ZAP_KEY = await getZapKey();
  if (!ZAP_KEY) return res.status(500).json({ error: 'ZapUPI not configured' });

  const orderId = String(req.body?.order_id || '').trim();
  if (!orderId) return res.status(400).json({ error: 'order_id required' });

  const userId = req.session.userId;
  const { rows: deps } = await query(
    `SELECT * FROM zapupi_deposits WHERE order_id=$1 AND user_id=$2`,
    [orderId, userId]
  );
  const deposit = deps[0];
  if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
  if (deposit.credited) return res.json({ status: 'success', credited: true, already: true });

  // Ask ZapUPI for status
  const data = await zapCall(STATUS_URL, { zap_key: ZAP_KEY, order_id: orderId });
  const node = data?.data || data?.result || data;
  const statusStr = String(node?.status || node?.payment_status || data?.status || '').toLowerCase();

  const isSuccess = ['success','completed','paid','settlement'].includes(statusStr) || data?.success === true;
  const isFailed  = ['failed','failure','expired'].includes(statusStr);

  if (isSuccess) {
    const inr   = Number(node?.amount || node?.pay_amount || deposit.amount_inr);
    const txnId = node?.utr || node?.txn_id || node?.upi_txn_id || deposit.txn_id || null;
    const utr   = node?.utr || node?.bank_ref || null;
    await creditWallet({ userId, orderId, amountInr: inr, txnId, utr });
    return res.json({ status: 'success', credited: true });
  }

  if (isFailed) {
    await query(`UPDATE zapupi_deposits SET status='failed', raw_response=$1 WHERE order_id=$2`, [data, orderId]);
    return res.json({ status: 'failed' });
  }

  return res.json({ status: 'pending' });
}));

// ─── POST /api/zapupi/webhook ─────────────────────────────────────────────────
// ZapUPI calls this when a payment completes. Always return 200.
router.post('/webhook', ah(async (req, res) => {
  res.json({ received: true }); // acknowledge immediately

  try {
    const ZAP_KEY = await getZapKey();
    if (!ZAP_KEY) return;

    const payload = req.body || {};
    const orderId = (
      payload.order_id || payload.client_txn_id || payload.user_token ||
      payload.data?.order_id || payload.data?.client_txn_id || ''
    ).toString().trim();

    if (!orderId || !orderId.startsWith('zap_')) {
      console.warn('[zapupi-webhook] unknown order_id:', orderId);
      return;
    }

    const { rows: deps } = await query(
      `SELECT * FROM zapupi_deposits WHERE order_id=$1`, [orderId]
    );
    const deposit = deps[0];
    if (!deposit || deposit.credited) return;

    // Verify with ZapUPI before crediting
    const data = await zapCall(STATUS_URL, { zap_key: ZAP_KEY, order_id: orderId });
    const node = data?.data || data?.result || data;
    const statusStr = String(node?.status || data?.status || '').toLowerCase();
    const isSuccess = ['success','completed','paid','settlement'].includes(statusStr);

    if (!isSuccess) return;

    const inr   = Number(node?.amount || node?.pay_amount || deposit.amount_inr);
    const txnId = node?.utr || node?.txn_id || payload.txn_id || null;
    const utr   = node?.utr || node?.bank_ref || null;
    await creditWallet({ userId: deposit.user_id, orderId, amountInr: inr, txnId, utr });
    console.log(`[zapupi-webhook] ✅ credited ₹${inr} for order ${orderId}`);
  } catch (e) {
    console.error('[zapupi-webhook] error:', e.message);
  }
}));

export default router;
