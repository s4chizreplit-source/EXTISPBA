// Subscription system removed.
//
// Any authenticated user may place orders — the only requirement is a
// sufficient wallet balance, which is enforced by the wallet debit logic.
// This helper is kept as a shim so existing callers keep working.

import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type PaymentEligibility =
  | { ok: true; reason: "admin" | "subscription" | "open" }
  | { ok: false; status: 403; error: string };

export async function assertPaymentEligible(
  _admin: SupabaseClient,
  userId: string,
  _ctx?: { source: string; request?: Request },
): Promise<PaymentEligibility> {
  if (!userId) {
    return { ok: false, status: 403, error: "Not authenticated" };
  }
  return { ok: true, reason: "open" };
}
