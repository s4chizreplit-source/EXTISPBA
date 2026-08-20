// Shared webhook idempotency / replay-protection helper.
// Every payment webhook (OxaPay, ZapUPI, Razorpay, ...) records an event row
// in public.webhook_events BEFORE any credit / activation logic runs.
//
// Duplicates are recognised via three unique keys enforced by the database:
//   1. (provider, order_id, payload_hash)  — exact replayed delivery
//   2. (provider, track_id)                — same provider transaction id
// If either constraint fires, we short-circuit and return duplicate:true.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type WebhookGateResult =
  | { duplicate: false; eventId: string; hash: string }
  | { duplicate: true; reason: "payload_replay" | "track_replay"; existing: any };

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function stableStringify(value: any): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",")}}`;
}

/**
 * Register a webhook delivery in the idempotency table.
 * Returns { duplicate: true, ... } if the same (provider, order_id, payload)
 * or (provider, track_id) has already been recorded.
 */
export async function registerWebhookEvent(
  supabase: SupabaseClient,
  args: {
    provider: string;
    orderId: string;
    trackId?: string | null;
    eventStatus?: string | null;
    payload: any;
  },
): Promise<WebhookGateResult> {
  const payloadStr = stableStringify(args.payload ?? {});
  const payloadHash = await sha256Hex(`${args.provider}|${args.orderId}|${payloadStr}`);

  // Fast path: exact-hash replay.
  const { data: sameHash } = await supabase
    .from("webhook_events")
    .select("id, outcome, first_seen_at")
    .eq("provider", args.provider)
    .eq("order_id", args.orderId)
    .eq("payload_hash", payloadHash)
    .maybeSingle();
  if (sameHash) {
    return { duplicate: true, reason: "payload_replay", existing: sameHash };
  }

  // Fast path: track_id already recorded for this provider — but only treat as
  // a replay when the event_status matches. Providers like OxaPay send multiple
  // legitimate webhook deliveries for the same track_id as the payment
  // progresses (e.g. "Paying" → "Paid"); those must NOT be blocked.
  if (args.trackId) {
    const { data: sameTrack } = await supabase
      .from("webhook_events")
      .select("id, order_id, outcome, first_seen_at, event_status")
      .eq("provider", args.provider)
      .eq("track_id", args.trackId)
      .eq("event_status", args.eventStatus || "")
      .maybeSingle();
    if (sameTrack) {
      return { duplicate: true, reason: "track_replay", existing: sameTrack };
    }
  }

  // Insert; unique indexes are the ultimate arbiter under concurrency.
  const { data: inserted, error } = await supabase
    .from("webhook_events")
    .insert({
      provider: args.provider,
      order_id: args.orderId,
      track_id: args.trackId || null,
      payload_hash: payloadHash,
      event_status: args.eventStatus || null,
      outcome: "received",
      payload: args.payload ?? null,
    })
    .select("id")
    .maybeSingle();

  if (error) {
    // 23505 = unique_violation → another concurrent delivery beat us to it.
    const code = (error as any).code;
    if (code === "23505") {
      return {
        duplicate: true,
        reason: (error.message || "").includes("track") ? "track_replay" : "payload_replay",
        existing: { message: error.message },
      };
    }
    throw error;
  }

  return { duplicate: false, eventId: inserted!.id, hash: payloadHash };
}

/** Update the event row after processing so audits can trace outcomes. */
export async function finalizeWebhookEvent(
  supabase: SupabaseClient,
  eventId: string | undefined,
  patch: { outcome: string; http_status?: number; message?: string | null },
) {
  if (!eventId) return;
  try {
    await supabase
      .from("webhook_events")
      .update({
        outcome: patch.outcome,
        http_status: patch.http_status ?? null,
        message: patch.message ?? null,
        processed_at: new Date().toISOString(),
      })
      .eq("id", eventId);
  } catch (e) {
    console.error("[webhook-idempotency] finalize failed", e);
  }
}

export function makeServiceClient(): SupabaseClient {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );
}
