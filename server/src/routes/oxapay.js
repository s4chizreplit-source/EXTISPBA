import { randomBytes } from 'node:crypto';
import express from 'express';
import { query, withTx } from '../db.js';
import { ah, requireAuth } from '../middleware/auth.js';
import {
  OxaPayProviderError,
  createOxaPayInvoice,
  getOxaPayPayment,
  isOxaPayFailed,
  isOxaPayPaid,
  makeOxaPayEventHash,
  normalizeOxaPayPayload,
  parseWalletTopupAmount,
  sanitizeOxaPayPayload,
  validateOxaPayPayment,
  verifyOxaPaySignature,
} from '../services/oxapay.js';

const router = express.Router();
const TERMINAL_FAILURE_STATUS = 'failed';

export function publicAppUrl() {
  const configured = String(process.env.PUBLIC_APP_URL || '').trim();
  if (!configured) {
    throw new OxaPayProviderError('Public application URL is not configured', 503);
  }
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:') throw new Error('HTTPS required');
    return url.origin;
  } catch {
    throw new OxaPayProviderError('Public application URL is not configured', 503);
  }
}

function safeMessage(value) {
  return String(value || '').replace(/\s+/g, ' ').slice(0, 500) || null;
}

async function logActivity(entry) {
  try {
    await query(
      `INSERT INTO oxapay_activity_log
        (source, event, order_id, user_id, plan_type, purpose, amount_usd,
         provider_status, http_status, ok, message, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        entry.source,
        entry.event,
        entry.orderId || null,
        entry.userId || null,
        entry.planType || null,
        entry.purpose || null,
        entry.amountUsd ?? null,
        entry.providerStatus || null,
        entry.httpStatus ?? null,
        entry.ok !== false,
        safeMessage(entry.message),
        entry.payload ? JSON.stringify(entry.payload) : null,
      ]
    );
  } catch (error) {
    console.error('[oxapay] activity log insert failed:', error.message);
  }
}

async function loadDeposit(orderId, userId = null) {
  const params = [orderId];
  let ownerClause = '';
  if (userId) {
    params.push(userId);
    ownerClause = ` AND user_id=$${params.length}`;
  }
  const { rows } = await query(
    `SELECT * FROM oxapay_deposits WHERE order_id=$1${ownerClause} LIMIT 1`,
    params
  );
  return rows[0] || null;
}

async function registerWebhookEvent({ orderId, trackId, status, payload }) {
  const payloadHash = makeOxaPayEventHash(orderId, payload);
  const safePayload = sanitizeOxaPayPayload(payload);
  const { rows } = await query(
    `INSERT INTO webhook_events
      (provider, order_id, track_id, payload_hash, event_status, outcome, payload)
     VALUES ('oxapay',$1,$2,$3,$4,'received',$5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [orderId, trackId || null, payloadHash, status || null, JSON.stringify(safePayload)]
  );
  if (rows[0]) {
    return { id: rows[0].id, duplicate: false, outcome: 'received' };
  }
  const { rows: existingRows } = await query(
    `SELECT id, outcome, http_status
       FROM webhook_events
      WHERE provider='oxapay'
        AND (
          (order_id=$1 AND payload_hash=$2)
          OR ($3::text IS NOT NULL AND track_id=$3 AND event_status=$4)
        )
      ORDER BY first_seen_at DESC
      LIMIT 1`,
    [orderId, payloadHash, trackId || null, status || null]
  );
  return {
    id: existingRows[0]?.id || null,
    duplicate: true,
    outcome: existingRows[0]?.outcome || null,
  };
}

async function finalizeWebhookEvent(eventId, outcome, httpStatus = 200, message = null) {
  if (!eventId) return;
  await query(
    `UPDATE webhook_events
        SET outcome=$1, http_status=$2, message=$3, processed_at=now()
      WHERE id=$4`,
    [outcome, httpStatus, safeMessage(message), eventId]
  ).catch(() => {});
}

export async function creditWalletDeposit(orderId, trackId) {
  return withTx(async client => {
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('oxapay:' || $1, 0))`,
      [orderId]
    );
    const { rows: [deposit] } = await client.query(
      `SELECT * FROM oxapay_deposits WHERE order_id=$1 FOR UPDATE`,
      [orderId]
    );
    if (!deposit) throw new OxaPayProviderError('Deposit not found', 404);
    if (deposit.purpose !== 'wallet') {
      throw new OxaPayProviderError('Unsupported OxaPay deposit purpose', 400);
    }
    if (deposit.credited) {
      const { rows: [wallet] } = await client.query(
        `SELECT balance FROM wallets WHERE user_id=$1`,
        [deposit.user_id]
      );
      return {
        credited: false,
        duplicate: true,
        newBalance: Number(wallet?.balance || 0),
        deposit,
      };
    }

    await client.query(
      `INSERT INTO wallets (user_id, balance, total_deposited, total_spent)
       VALUES ($1,0,0,0)
       ON CONFLICT (user_id) DO NOTHING`,
      [deposit.user_id]
    );
    const { rows: [wallet] } = await client.query(
      `UPDATE wallets
          SET balance=trunc(COALESCE(balance,0) + trunc($1::numeric,4),4),
              total_deposited=trunc(COALESCE(total_deposited,0) + trunc($1::numeric,4),4),
              updated_at=now()
        WHERE user_id=$2
      RETURNING balance`,
      [deposit.amount_usd, deposit.user_id]
    );
    if (!wallet) throw new OxaPayProviderError('Wallet not found', 500);

    await client.query(
      `INSERT INTO transactions
        (user_id, type, amount, balance_after, status, payment_method,
         payment_reference, description)
       VALUES ($1,'deposit',trunc($2::numeric,4),$3,'completed','oxapay',$4,
               'Wallet top-up via OxaPay (crypto)')`,
      [deposit.user_id, deposit.amount_usd, wallet.balance, orderId]
    );
    await client.query(
      `UPDATE oxapay_deposits
          SET credited=true, status='credited', track_id=COALESCE($1,track_id),
              updated_at=now()
        WHERE id=$2`,
      [trackId || null, deposit.id]
    );

    return {
      credited: true,
      duplicate: false,
      newBalance: Number(wallet.balance),
      creditedUsd: Number(deposit.amount_usd),
      deposit,
    };
  });
}

async function verifyAndMaybeCredit(deposit, requestedTrackId) {
  const trackId = String(requestedTrackId || deposit.track_id || '');
  if (!trackId) throw new OxaPayProviderError('Deposit is missing provider track ID', 400);
  if (deposit.track_id && String(deposit.track_id) !== trackId) {
    throw new OxaPayProviderError('Provider track ID does not match this deposit', 400);
  }

  const { payload, payment } = await getOxaPayPayment(trackId);
  const validation = validateOxaPayPayment(payload, deposit, trackId);
  const safePayload = sanitizeOxaPayPayload(payload);

  if (!validation.paid) {
    const nextStatus = isOxaPayFailed(payment.status)
      ? TERMINAL_FAILURE_STATUS
      : (payment.status || 'pending');
    await query(
      `UPDATE oxapay_deposits
          SET status=$1, raw_response=$2, updated_at=now()
        WHERE id=$3 AND credited=false`,
      [nextStatus, JSON.stringify(safePayload), deposit.id]
    );
    return { credited: false, status: nextStatus, providerStatus: payment.status };
  }

  await query(
    `UPDATE oxapay_deposits
        SET status='paid', raw_response=$1, updated_at=now()
      WHERE id=$2 AND credited=false`,
    [JSON.stringify(safePayload), deposit.id]
  );
  const result = await creditWalletDeposit(deposit.order_id, trackId);
  return { ...result, status: 'success', providerStatus: payment.status };
}

router.post(
  '/create-wallet-topup',
  requireAuth,
  ah(async (req, res) => {
    let amounts;
    try {
      amounts = parseWalletTopupAmount(req.body?.amount_inr);
    } catch (error) {
      return res.status(error.status || 400).json({ error: error.message });
    }

    const { rows: [recent] } = await query(
      `SELECT count(*)::int AS count
         FROM oxapay_deposits
        WHERE user_id=$1 AND created_at > now() - interval '1 minute'`,
      [req.session.userId]
    );
    if (Number(recent?.count || 0) >= 5) {
      return res.status(429).json({ error: 'Too many payment requests. Please wait one minute.' });
    }

    const { rows: [user] } = await query(
      `SELECT email FROM auth_users WHERE id=$1`,
      [req.session.userId]
    );
    if (!user) return res.status(401).json({ error: 'Not authenticated' });

    const orderId =
      `oxw_${req.session.userId.slice(0, 8)}_${Date.now()}_${randomBytes(4).toString('hex')}`;
    await query(
      `INSERT INTO oxapay_deposits
        (user_id, purpose, order_id, amount_usd, amount_inr, status, email)
       VALUES ($1,'wallet',$2,$3,$4,'pending',$5)`,
      [
        req.session.userId,
        orderId,
        amounts.amountUsd,
        amounts.amountInr,
        user.email || null,
      ]
    );

    try {
      const appUrl = publicAppUrl();
      const { payload, invoice } = await createOxaPayInvoice({
        amount: amounts.amountUsd,
        currency: 'USD',
        lifetime: 30,
        fee_paid_by_payer: 1,
        // OxaPay marks at most 1% underpayment as valid, matching our >=99% rule.
        under_paid_coverage: 1,
        to_currency: 'USDT',
        auto_withdrawal: 0,
        mixed_payment: 0,
        callback_url: `${appUrl}/api/oxapay/webhook`,
        return_url: `${appUrl}/wallet?deposit=success&order_id=${encodeURIComponent(orderId)}`,
        email: user.email || '',
        order_id: orderId,
        description: `Wallet top-up INR ${amounts.amountInr}`,
      });
      await query(
        `UPDATE oxapay_deposits
            SET track_id=$1, pay_link=$2, raw_response=$3, updated_at=now()
          WHERE order_id=$4`,
        [
          invoice.trackId,
          invoice.paymentUrl,
          JSON.stringify(sanitizeOxaPayPayload(payload)),
          orderId,
        ]
      );
      await logActivity({
        source: 'checkout',
        event: 'invoice_created',
        orderId,
        userId: req.session.userId,
        purpose: 'wallet',
        amountUsd: amounts.amountUsd,
        providerStatus: invoice.status || 'new',
        message: 'OxaPay checkout created',
      });
      return res.json({
        success: true,
        payment_url: invoice.paymentUrl,
        order_id: orderId,
        amount_usd: amounts.amountUsd,
        amount_inr: amounts.amountInr,
      });
    } catch (error) {
      const status = error.status || 502;
      await query(
        `UPDATE oxapay_deposits
            SET status='failed', raw_response=$1, updated_at=now()
          WHERE order_id=$2`,
        [JSON.stringify({ error: safeMessage(error.message) }), orderId]
      ).catch(() => {});
      await logActivity({
        source: 'checkout',
        event: 'invoice_create_failed',
        orderId,
        userId: req.session.userId,
        purpose: 'wallet',
        amountUsd: amounts.amountUsd,
        httpStatus: status,
        ok: false,
        message: error.message,
      });
      return res.status(status).json({ error: error.message || 'Payment provider error' });
    }
  })
);

router.post(
  '/sync-deposit',
  requireAuth,
  ah(async (req, res) => {
    const orderId = String(req.body?.order_id || '').trim();
    if (!/^oxw_[a-f0-9-]{8}_[0-9]+_[a-f0-9]{8}$/i.test(orderId)) {
      return res.status(400).json({ error: 'Valid order_id required' });
    }
    const deposit = await loadDeposit(orderId, req.session.userId);
    if (!deposit) return res.status(404).json({ error: 'Deposit not found' });
    if (deposit.credited) return res.json({ credited: true, status: 'success' });
    if (!deposit.track_id) {
      return res.json({
        credited: false,
        status: deposit.status === 'failed' ? 'failed' : 'pending',
      });
    }

    try {
      const previousStatus = deposit.status;
      const result = await verifyAndMaybeCredit(deposit, deposit.track_id);
      if (result.credited || result.duplicate) {
        await logActivity({
          source: 'poller',
          event: result.duplicate ? 'already_credited' : 'wallet_credited',
          orderId,
          userId: deposit.user_id,
          purpose: 'wallet',
          amountUsd: Number(deposit.amount_usd),
          providerStatus: result.providerStatus,
          message: result.duplicate ? 'Payment was already credited' : 'Wallet credited after provider verification',
        });
        return res.json({ credited: true, status: 'success' });
      }
      if (result.status !== previousStatus) {
        await logActivity({
          source: 'poller',
          event: result.status === 'failed' ? 'invoice_failed' : 'status_update',
          orderId,
          userId: deposit.user_id,
          purpose: 'wallet',
          amountUsd: Number(deposit.amount_usd),
          providerStatus: result.providerStatus,
          message: `Provider status: ${result.providerStatus || 'pending'}`,
        });
      }
      return res.json({
        credited: false,
        status: result.status === 'failed' ? 'failed' : 'pending',
        provider_status: result.providerStatus,
      });
    } catch (error) {
      await logActivity({
        source: 'poller',
        event: error.status === 400 ? 'verification_rejected' : 'provider_check_failed',
        orderId,
        userId: deposit.user_id,
        purpose: 'wallet',
        amountUsd: Number(deposit.amount_usd),
        providerStatus: error.providerStatus,
        httpStatus: error.status || 500,
        ok: false,
        message: error.message,
      });
      return res.status(error.status || 500).json({
        error: error.message || 'Could not verify payment',
        status: error.status === 400 ? 'failed' : 'pending',
      });
    }
  })
);

router.post(
  '/webhook',
  ah(async (req, res) => {
    const merchantKey = process.env.OXAPAY_MERCHANT_API_KEY || '';
    const signature = req.get('HMAC') || '';
    const safePayload = sanitizeOxaPayPayload(req.body);
    const normalized = normalizeOxaPayPayload(req.body);

    if (!verifyOxaPaySignature(req.rawBody, signature, merchantKey)) {
      await logActivity({
        source: 'webhook',
        event: 'invalid_signature',
        orderId: normalized.orderId || null,
        providerStatus: normalized.status,
        httpStatus: 401,
        ok: false,
        message: 'Webhook HMAC signature verification failed',
        payload: safePayload,
      });
      return res.status(401).type('text/plain').send('invalid signature');
    }
    if (!normalized.orderId || !normalized.trackId) {
      await logActivity({
        source: 'webhook',
        event: 'missing_required_field',
        orderId: normalized.orderId || null,
        providerStatus: normalized.status,
        httpStatus: 400,
        ok: false,
        message: 'Webhook is missing order_id or track_id',
        payload: safePayload,
      });
      return res.status(400).type('text/plain').send('invalid payload');
    }

    const deposit = await loadDeposit(normalized.orderId);
    if (!deposit) {
      await logActivity({
        source: 'webhook',
        event: 'deposit_not_found',
        orderId: normalized.orderId,
        providerStatus: normalized.status,
        httpStatus: 404,
        ok: false,
        message: 'Deposit not found',
        payload: safePayload,
      });
      return res.status(404).type('text/plain').send('deposit not found');
    }
    if (deposit.track_id && String(deposit.track_id) !== normalized.trackId) {
      await logActivity({
        source: 'webhook',
        event: 'track_id_mismatch',
        orderId: normalized.orderId,
        userId: deposit.user_id,
        purpose: deposit.purpose,
        amountUsd: Number(deposit.amount_usd),
        providerStatus: normalized.status,
        httpStatus: 400,
        ok: false,
        message: 'Webhook track ID does not match the stored deposit',
        payload: safePayload,
      });
      return res.status(400).type('text/plain').send('invalid track');
    }

    const webhookEvent = await registerWebhookEvent({
      orderId: normalized.orderId,
      trackId: normalized.trackId,
      status: normalized.status,
      payload: req.body,
    });
    const eventId = webhookEvent.id;
    await query(
      `UPDATE oxapay_deposits
          SET webhook_payload=$1, updated_at=now()
        WHERE id=$2`,
      [JSON.stringify(safePayload), deposit.id]
    );

    if (webhookEvent.duplicate) {
      if (deposit.credited || webhookEvent.outcome === 'wallet_credited' || webhookEvent.outcome === 'duplicate') {
        return res.status(200).type('text/plain').send('ok');
      }
      if (!isOxaPayPaid(normalized.status) || webhookEvent.outcome === 'verification_rejected') {
        return res.status(200).type('text/plain').send('ok');
      }
      // A prior provider_error remains retryable. Reuse and finalize the
      // original audit event while the deposit row lock preserves idempotency.
    }

    if (!isOxaPayPaid(normalized.status)) {
      const nextStatus = isOxaPayFailed(normalized.status)
        ? TERMINAL_FAILURE_STATUS
        : (normalized.status || 'pending');
      await query(
        `UPDATE oxapay_deposits SET status=$1, updated_at=now()
          WHERE id=$2 AND credited=false`,
        [nextStatus, deposit.id]
      );
      await logActivity({
        source: 'webhook',
        event: nextStatus === 'failed' ? 'invoice_failed' : 'status_update',
        orderId: normalized.orderId,
        userId: deposit.user_id,
        purpose: deposit.purpose,
        amountUsd: Number(deposit.amount_usd),
        providerStatus: normalized.status,
        message: `Provider status: ${normalized.status || 'pending'}`,
        payload: safePayload,
      });
      await finalizeWebhookEvent(eventId, nextStatus, 200);
      return res.status(200).type('text/plain').send('ok');
    }

    try {
      const result = await verifyAndMaybeCredit(deposit, normalized.trackId);
      if (!result.credited && !result.duplicate) {
        await finalizeWebhookEvent(eventId, 'provider_not_paid', 502);
        return res.status(502).type('text/plain').send('provider verification pending');
      }
      await logActivity({
        source: 'webhook',
        event: result.duplicate ? 'duplicate_paid_webhook' : 'wallet_credited',
        orderId: normalized.orderId,
        userId: deposit.user_id,
        purpose: deposit.purpose,
        amountUsd: Number(deposit.amount_usd),
        providerStatus: result.providerStatus,
        message: result.duplicate ? 'Payment was already credited' : 'Wallet credited after provider verification',
        payload: safePayload,
      });
      await finalizeWebhookEvent(eventId, result.duplicate ? 'duplicate' : 'wallet_credited', 200);
      return res.status(200).type('text/plain').send('ok');
    } catch (error) {
      const providerFailure = error instanceof OxaPayProviderError && error.status >= 500;
      await logActivity({
        source: 'webhook',
        event: providerFailure ? 'provider_check_failed' : 'verification_rejected',
        orderId: normalized.orderId,
        userId: deposit.user_id,
        purpose: deposit.purpose,
        amountUsd: Number(deposit.amount_usd),
        providerStatus: error.providerStatus || normalized.status,
        httpStatus: error.status || 500,
        ok: false,
        message: error.message,
        payload: safePayload,
      });
      await finalizeWebhookEvent(
        eventId,
        providerFailure ? 'provider_error' : 'verification_rejected',
        error.status || 500,
        error.message
      );
      if (providerFailure) {
        return res.status(error.status || 502).type('text/plain').send('provider unavailable');
      }
      // The callback itself is authentic, but payment validation failed.
      // Acknowledge it so OxaPay does not replay a permanently invalid event.
      return res.status(200).type('text/plain').send('ok');
    }
  })
);

export default router;