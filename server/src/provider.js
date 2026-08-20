/**
 * Reseller/provider API client (standard SMM panel API v2 shape).
 * Configure with PROVIDER_API_URL + PROVIDER_API_KEY.
 * When unset, runs in "simulate" mode so the panel stays usable without a provider.
 */

const API_URL = process.env.PROVIDER_API_URL || '';
const API_KEY = process.env.PROVIDER_API_KEY || '';

export const providerConfigured = Boolean(API_URL && API_KEY);

async function call(params, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ key: API_KEY, ...params });
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`Provider returned non-JSON: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Place an order with the provider. Returns { providerOrderId, raw }. */
export async function placeProviderOrder({ providerServiceId, link, quantity }) {
  if (!providerConfigured || !providerServiceId) {
    return {
      providerOrderId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      raw: { simulated: true, reason: providerConfigured ? 'no_provider_service_id' : 'provider_not_configured' },
    };
  }
  const raw = await call({
    action: 'add',
    service: String(providerServiceId),
    link,
    quantity: String(quantity),
  });
  if (raw.error) {
    throw new Error(typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error));
  }
  const providerOrderId = String(raw.order ?? raw.id ?? '');
  if (!providerOrderId) throw new Error('Provider did not return an order id');
  return { providerOrderId, raw };
}

const STATUS_MAP = {
  pending: 'pending',
  'in progress': 'processing',
  processing: 'processing',
  completed: 'completed',
  partial: 'partial',
  canceled: 'cancelled',
  cancelled: 'cancelled',
};

/** Fetch live status. Returns { status, startCount, remains, raw } or null. */
export async function fetchProviderStatus(providerOrderId) {
  if (!providerConfigured || !providerOrderId || providerOrderId.startsWith('sim_')) return null;
  const raw = await call({ action: 'status', order: String(providerOrderId) });
  if (raw.error) return null;
  return {
    status: STATUS_MAP[String(raw.status || '').toLowerCase()] || 'processing',
    startCount: Number(raw.start_count ?? 0) || null,
    remains: Number(raw.remains ?? 0) || 0,
    raw,
  };
}

/** Provider account balance, or null when unavailable. */
export async function fetchProviderBalance() {
  if (!providerConfigured) return null;
  const raw = await call({ action: 'balance' });
  if (raw.error) return null;
  return { balance: Number(raw.balance ?? 0), currency: raw.currency ?? 'USD' };
}
