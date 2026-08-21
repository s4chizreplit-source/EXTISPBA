/**
 * Reseller/provider API client — reads credentials from provider_accounts table.
 * Falls back to PROVIDER_API_URL + PROVIDER_API_KEY env vars if set.
 * Missing configuration is an explicit failure; fake provider orders are never created.
 */

import { query } from './db.js';
import { getEnvProvider, isValidProviderApiUrl } from './provider-config.js';

const ENV_PROVIDER = getEnvProvider();

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

/** Pick the highest-priority mapped account; use validated env config only as fallback. */
async function pickAccount(serviceId = null) {
  if (serviceId) {
    const { rows } = await query(
      `SELECT pa.id, pa.api_url, pa.api_key, m.provider_service_id
         FROM service_provider_mapping m
         JOIN provider_accounts pa ON pa.id = m.provider_account_id
        WHERE m.service_id = $1
          AND m.is_active = true
          AND pa.is_active = true
          AND NULLIF(TRIM(pa.api_key), '') IS NOT NULL
          AND pa.api_url ~* '^https?://'
        ORDER BY m.sort_order ASC, pa.last_used_at ASC NULLS FIRST
        LIMIT 1`,
      [serviceId]
    );
    if (rows[0]) return rows[0];

    // Legacy regular services may be linked directly to providers without a
    // service_provider_mapping row. Respect only active, credentialed providers.
    const { rows: legacyRows } = await query(
      `SELECT NULL::uuid AS id, p.api_url, p.api_key, s.provider_service_id
         FROM services s
         JOIN providers p ON p.id = s.provider_id
        WHERE s.id = $1
          AND s.is_active = true
          AND p.is_active = true
          AND NULLIF(TRIM(p.api_key), '') IS NOT NULL
          AND p.api_url ~* '^https?://'
        LIMIT 1`,
      [serviceId]
    );
    if (legacyRows[0]) return legacyRows[0];
  } else {
    const { rows } = await query(
      `SELECT id, api_url, api_key FROM provider_accounts
        WHERE is_active = true
          AND NULLIF(TRIM(api_key), '') IS NOT NULL
          AND api_url ~* '^https?://'
        ORDER BY last_used_at ASC NULLS FIRST
        LIMIT 1`
    );
    if (rows[0]) return rows[0];
  }

  return ENV_PROVIDER;
}

/** Mark account as used (updates last_used_at for LRU rotation). */
async function markUsed(id) {
  if (!id) return;
  await query(`UPDATE provider_accounts SET last_used_at = now() WHERE id = $1`, [id]).catch(() => {});
}

/** Low-level HTTP call to SMM panel API. */
async function callProvider({ api_url, api_key }, params, timeoutMs = 20000) {
  if (!isValidProviderApiUrl(api_url)) {
    throw new Error('Provider API URL is not a valid HTTP(S) endpoint');
  }
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
export async function placeProviderOrder({ serviceId, providerServiceId, link, quantity }) {
  const acct = await pickAccount(serviceId);
  if (!acct) {
    throw new Error('No active provider account is configured');
  }
  const resolvedProviderServiceId = acct.provider_service_id || providerServiceId;
  if (!resolvedProviderServiceId) {
    throw new Error('Provider service ID is not configured');
  }

  const raw = await callProvider(acct, {
    action: 'add',
    service: String(resolvedProviderServiceId),
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
export async function fetchProviderStatus(providerOrderId, serviceId = null) {
  if (!providerOrderId || providerOrderId.startsWith('sim_')) return null;

  // Try env vars first, then DB
  const acct = await pickAccount(serviceId);
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

/** Provider account balance — optionally verifies the provider for one service. */
export async function fetchProviderBalance(serviceId = null) {
  const acct = await pickAccount(serviceId);
  if (!acct) return null;
  try {
    const raw = await callProvider(acct, { action: 'balance' });
    if (raw.error) return null;
    return { balance: Number(raw.balance ?? 0), currency: raw.currency ?? 'USD' };
  } catch {
    return null;
  }
}
