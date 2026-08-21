import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

export const OXAPAY_API_BASE = 'https://api.oxapay.com/v1';
export const OXAPAY_MIN_INR = 100;
export const OXAPAY_MAX_INR = 500000;
export const OXAPAY_USD_INR = 83.5;

const PAID_STATUSES = new Set(['paid', 'confirmed']);
const FAILED_STATUSES = new Set(['expired', 'failed', 'canceled', 'cancelled']);

export class OxaPayProviderError extends Error {
  constructor(message, status = 502, providerStatus = null) {
    super(message);
    this.name = 'OxaPayProviderError';
    this.status = status;
    this.providerStatus = providerStatus;
  }
}

export function parseWalletTopupAmount(value) {
  const amountInr = Math.floor(Number(value) || 0);
  if (!amountInr || amountInr < OXAPAY_MIN_INR) {
    throw new OxaPayProviderError(`Minimum is INR ${OXAPAY_MIN_INR}`, 400);
  }
  if (amountInr > OXAPAY_MAX_INR) {
    throw new OxaPayProviderError(`Maximum is INR ${OXAPAY_MAX_INR}`, 400);
  }
  const amountUsd = Number((amountInr / OXAPAY_USD_INR).toFixed(2));
  if (amountUsd < 1) {
    throw new OxaPayProviderError('Amount too small', 400);
  }
  return { amountInr, amountUsd };
}

export function normalizeOxaPayPayload(payload) {
  const data = payload?.data && typeof payload.data === 'object' ? payload.data : payload || {};
  const paidAmountValue = data.paid_amount ?? data.paidAmount;
  return {
    raw: payload,
    status: String(data.status || '').trim().toLowerCase(),
    trackId: data.track_id != null
      ? String(data.track_id)
      : data.trackId != null ? String(data.trackId) : '',
    orderId: data.order_id != null
      ? String(data.order_id)
      : data.orderId != null ? String(data.orderId) : '',
    amount: Number(data.amount ?? 0),
    currency: String(data.currency || '').trim().toUpperCase(),
    paidAmount: paidAmountValue == null ? null : Number(paidAmountValue),
    paidCurrency: String(data.paid_currency || data.paidCurrency || '').trim().toUpperCase(),
    paymentUrl: data.payment_url || data.paymentUrl || data.pay_link || '',
    expiredAt: data.expired_at || data.expiredAt || null,
  };
}

export function sanitizeOxaPayPayload(payload) {
  const normalized = normalizeOxaPayPayload(payload);
  return {
    status: normalized.status || null,
    track_id: normalized.trackId || null,
    order_id: normalized.orderId || null,
    amount: Number.isFinite(normalized.amount) && normalized.amount > 0
      ? normalized.amount
      : null,
    currency: normalized.currency || null,
    paid_amount: Number.isFinite(normalized.paidAmount) && normalized.paidAmount >= 0
      ? normalized.paidAmount
      : null,
    paid_currency: normalized.paidCurrency || null,
    expired_at: normalized.expiredAt,
  };
}

export function isOxaPayPaid(status) {
  return PAID_STATUSES.has(String(status || '').toLowerCase());
}

export function isOxaPayFailed(status) {
  return FAILED_STATUSES.has(String(status || '').toLowerCase());
}

function decimalUnits(value, scale = 10000) {
  return Math.round(Number(value) * scale);
}

export function validateOxaPayPayment(providerPayload, deposit, trackId) {
  const payment = normalizeOxaPayPayload(providerPayload);
  const expectedTrackId = String(trackId || deposit.track_id || '');
  const expectedOrderId = String(deposit.order_id || '');
  const expectedAmount = Number(deposit.amount_usd);

  if (!isOxaPayPaid(payment.status)) {
    return { paid: false, payment };
  }
  if (!payment.trackId || payment.trackId !== expectedTrackId) {
    throw new OxaPayProviderError('Provider track ID does not match this deposit', 400, payment.status);
  }
  if (!payment.orderId || payment.orderId !== expectedOrderId) {
    throw new OxaPayProviderError('Provider order ID does not match this deposit', 400, payment.status);
  }
  if (payment.currency !== 'USD') {
    throw new OxaPayProviderError('Provider payment currency does not match USD invoice', 400, payment.status);
  }
  if (!Number.isFinite(payment.amount) || payment.amount <= 0) {
    throw new OxaPayProviderError('Provider payment amount is missing', 400, payment.status);
  }
  // `amount` is the invoice's fiat amount, not the crypto transaction amount.
  // It must identify the exact invoice we created, within one cent for decimal
  // serialization differences.
  const invoiceAmountUnits = decimalUnits(payment.amount, 100);
  const expectedAmountCents = decimalUnits(expectedAmount, 100);
  if (Math.abs(invoiceAmountUnits - expectedAmountCents) > 1) {
    throw new OxaPayProviderError('Provider payment amount does not match this deposit', 400, payment.status);
  }
  const expectedPaidUnits = decimalUnits(expectedAmount);
  const actualPaidUnits = payment.paidAmount == null ? null : decimalUnits(payment.paidAmount);
  if (
    actualPaidUnits != null &&
    (!Number.isFinite(payment.paidAmount) || actualPaidUnits * 100 < expectedPaidUnits * 99)
  ) {
    throw new OxaPayProviderError('Payment is underpaid', 400, payment.status);
  }
  if (payment.paidAmount != null && payment.paidCurrency && payment.paidCurrency !== 'USD') {
    throw new OxaPayProviderError('Provider paid currency does not match USD invoice', 400, payment.status);
  }
  // Current OxaPay v1 does not expose a separate fiat paid amount. Its `paid`
  // status means the payment is confirmed and credited to the merchant, while
  // invoice creation limits accepted underpayment to 1%. If a legacy response
  // includes `paid_amount`, the explicit 99% check above takes precedence.
  // Legitimate overpayment never increases wallet credit: the fixed stored
  // invoice amount is credited exactly once.

  return { paid: true, payment };
}

export function verifyOxaPaySignature(rawBody, signature, merchantKey) {
  if (!Buffer.isBuffer(rawBody) || !merchantKey) return false;
  const supplied = String(signature || '').trim().toLowerCase();
  if (!/^[a-f0-9]{128}$/.test(supplied)) return false;
  const expected = createHmac('sha512', merchantKey).update(rawBody).digest();
  const actual = Buffer.from(supplied, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function makeOxaPayEventHash(orderId, payload) {
  const stablePayload = stableStringify(payload ?? {});
  return createHash('sha256')
    .update(`oxapay|${orderId}|${stablePayload}`)
    .digest('hex');
}

function getMerchantKey() {
  const key = process.env.OXAPAY_MERCHANT_API_KEY;
  if (!key) throw new OxaPayProviderError('Crypto payments are not configured', 503);
  return key;
}

async function callOxaPay(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${OXAPAY_API_BASE}${path}`, {
      ...options,
      headers: {
        accept: 'application/json',
        merchant_api_key: getMerchantKey(),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
    const providerCode = Number(payload?.status);
    if (
      !response.ok ||
      (Number.isFinite(providerCode) && providerCode >= 400) ||
      payload?.error
    ) {
      const providerMessage =
        payload?.message ||
        payload?.error?.message ||
        payload?.error ||
        `OxaPay returned HTTP ${response.status}`;
      throw new OxaPayProviderError(String(providerMessage).slice(0, 300), 502);
    }
    return payload;
  } catch (error) {
    if (error instanceof OxaPayProviderError) throw error;
    if (error?.name === 'AbortError') {
      throw new OxaPayProviderError('OxaPay request timed out', 504);
    }
    throw new OxaPayProviderError('OxaPay is temporarily unavailable', 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function createOxaPayInvoice(request) {
  const payload = await callOxaPay('/payment/invoice', {
    method: 'POST',
    body: JSON.stringify(request),
  });
  const invoice = normalizeOxaPayPayload(payload);
  if (!invoice.trackId || !invoice.paymentUrl) {
    throw new OxaPayProviderError('OxaPay returned an incomplete invoice', 502);
  }
  return { payload, invoice };
}

export async function getOxaPayPayment(trackId) {
  if (!trackId) throw new OxaPayProviderError('OxaPay track ID is required', 400);
  const payload = await callOxaPay(`/payment/${encodeURIComponent(trackId)}`, {
    method: 'GET',
  });
  return { payload, payment: normalizeOxaPayPayload(payload) };
}