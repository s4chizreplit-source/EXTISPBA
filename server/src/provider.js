/**
 * Reseller/provider API client — reads credentials from provider_accounts table.
 * Falls back to PROVIDER_API_URL + PROVIDER_API_KEY env vars if set.
 * When neither is available, runs in "simulate" mode.
 */

import { query } from './db.js';

const ENV_URL = process.env.PROVIDER_API_URL || '';
const ENV_KEY = process.env.PROVIDER_API_KEY || '';

// providerConfigured is now always true — DB has actual accounts.
// We expose it as a getter so it reflects live DB state.
export const providerConfigured = true;

const STATUS_MAP = {
  pending: 'pending',
  'in progress': 'processing',
  processing: 'processing',
  completed: 'completed',
  partial: 'partial',
  canceled: 'cancelled',
  cancelled: 'cancelled',
};

/** Pick the least-recently-used active provider account from DB. */
async function pickAccount() {
  // Prefer env vars if set (manual override)
  if (ENV_URL && ENV_KEY) return { api_url: ENV_URL, api_key: ENV_KEY, id: null };

  const { rows } = await query(
    `SELECT id, api_url, api_key FROM provider_accounts
      WHERE is_active = true
      ORDER BY last_used_at ASC NULLS FIRST
      LIMIT 1`
  );
  if (!rows[0]) return null;
  return rows[0];
}

/** Mark account as used (updates last_used_at for LRU rotation). */
async function markUsed(id) {
  if (!id) return;
  await query(`UPDATE provider_accounts SET last_used_at = now() WHERE id = $1`, [id]).catch(() => {});
}

/** Low-level HTTP call to SMM panel API. */
async function callProvider({ api_url, api_key }, params, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = new URLSearchParams({ key: api_key, ...params });
    const res = await fetch(api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Provider HTTP ${res.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`Provider returned non-JSON: ${text.slice(0, 300)}`); }
  } finally {
    clearTimeout(timer);
  }
}

/** Place an order with the provider. Returns { providerOrderId, raw, accountId }. */
export async function placeProviderOrder({ providerServiceId, link, quantity }) {
  if (!providerServiceId) {
    return {
      providerOrderId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      raw: { simulated: true, reason: 'no_provider_service_id' },
      accountId: null,
    };
  }

  const acct = await pickAccount();
  if (!acct) {
    return {
      providerOrderId: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      raw: { simulated: true, reason: 'no_active_provider_accounts' },
      accountId: null,
    };
  }

  const raw = await callProvider(acct, {
    action: 'add',
    service: String(providerServiceId),
    link,
    quantity: String(quantity),
  });
  await markUsed(acct.id);

  if (raw.error) throw new Error(typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error));
  const providerOrderId = String(raw.order ?? raw.id ?? '');
  if (!providerOrderId) throw new Error('Provider did not return an order id');
  return { providerOrderId, raw, accountId: acct.id };
}

/** Fetch live status for a placed order. Returns status object or null. */
export async function fetchProviderStatus(providerOrderId) {
  if (!providerOrderId || providerOrderId.startsWith('sim_')) return null;

  // Try env vars first, then DB
  const acct = await pickAccount();
  if (!acct) return null;

  try {
    const raw = await callProvider(acct, { action: 'status', order: String(providerOrderId) });
    if (raw.error) return null;
    return {
      status: STATUS_MAP[String(raw.status || '').toLowerCase()] || 'processing',
      startCount: Number(raw.start_count ?? 0) || null,
      remains: Number(raw.remains ?? 0) || 0,
      raw,
    };
  } catch {
    return null;
  }
}

/** Provider account balance — picks first active account. */
export async function fetchProviderBalance() {
  const acct = await pickAccount();
  if (!acct) return null;
  try {
    const raw = await callProvider(acct, { action: 'balance' });
    if (raw.error) return null;
    return { balance: Number(raw.balance ?? 0), currency: raw.currency ?? 'USD' };
  } catch {
    return null;
  }
}
