import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerWebhookEvent, finalizeWebhookEvent } from "../_shared/webhook-idempotency.ts";
import { recordSecurityEvent } from "../_shared/security-audit.ts";
import { escapeTelegramHtml, notifyAdminTelegram } from "../_shared/admin-telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, hmac",
};

const OXAPAY_INFO = "https://api.oxapay.com/v1/payment/";

async function verifyWithProvider(apiKey: string, trackId: string) {
  try {
    const resp = await fetch(`${OXAPAY_INFO}${encodeURIComponent(trackId)}`, {
      headers: { "merchant_api_key": apiKey },
    });
    const raw = await resp.text();
    let data: any = null;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    const inner = data?.data || data;
    return {
      ok: resp.ok,
      status: String(inner?.status || "").toLowerCase(),
      paidAmount: Number(inner?.paid_amount ?? inner?.paidAmount ?? inner?.amount ?? 0),
      email: inner?.email || inner?.payer_email || null,
      raw: data,
    };
  } catch (e: any) {
    return { ok: false, status: "", paidAmount: 0, email: null, raw: { error: e?.message } };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const OXA_API_KEY = Deno.env.get("OXAPAY_MERCHANT_API_KEY") || "";

  async function logActivity(entry: {
    event: string;
    order_id?: string | null;
    user_id?: string | null;
    plan_type?: string | null;
    purpose?: string | null;
    amount_usd?: number | null;
    provider_status?: string | null;
    http_status?: number | null;
    ok?: boolean;
    message?: string | null;
    payload?: any;
  }) {
    try {
      await supabase.from("oxapay_activity_log").insert({
        source: "webhook",
        ok: true,
        ...entry,
      });
    } catch (e) {
      console.error("log insert failed", e);
    }
  }

  try {
    const raw = await req.text();
    let payload: any = null;
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }

    console.log("[oxapay-webhook] payload:", JSON.stringify(payload).slice(0, 800));

    const inner = payload?.data || payload;
    const orderId: string | undefined =
      inner?.order_id || inner?.orderId || payload?.order_id;
    const trackId: string | undefined =
      inner?.track_id || inner?.trackId || payload?.track_id;
    const status = String(inner?.status || payload?.status || "").toLowerCase();
    const paidAmount = Number(inner?.paid_amount ?? inner?.paidAmount ?? inner?.amount ?? 0);
    const payerEmail: string | undefined =
      inner?.email || inner?.payer_email || payload?.email || inner?.buyer_email;

    if (!orderId) {
      await logActivity({ event: "missing_order_id", ok: false, http_status: 400, message: "no order_id in webhook payload", payload });
      await recordSecurityEvent(supabase, {
        category: "webhook_missing_field",
        source: "oxapay-webhook",
        reason: "missing order_id in webhook payload",
        provider: "oxapay",
        http_status: 400,
        request: req,
        payload,
      });
      return json({ ok: false, error: "missing order_id" }, 400);
    }

    // === Universal idempotency / replay protection ===
    let webhookEventId: string | undefined;
    try {
      const gate = await registerWebhookEvent(supabase, {
        provider: "oxapay",
        orderId,
        trackId: trackId ? String(trackId) : null,
        eventStatus: status,
        payload,
      });
      if (gate.duplicate) {
        await logActivity({ event: "webhook_replay_blocked", order_id: orderId, provider_status: status, message: `duplicate delivery (${gate.reason})`, payload });
        await recordSecurityEvent(supabase, {
          category: "webhook_replay",
          source: "oxapay-webhook",
          reason: `duplicate delivery (${gate.reason})`,
          provider: "oxapay",
          order_id: orderId,
          track_id: trackId ? String(trackId) : null,
          http_status: 200,
          request: req,
          payload,
          metadata: { gate_reason: gate.reason },
        });
        return json({ ok: true, duplicate: true, reason: gate.reason });
      }
      webhookEventId = gate.eventId;
    } catch (e: any) {
      console.error("[oxapay-webhook] idempotency gate error", e);
    }


    let { data: dep, error: fetchErr } = await supabase
      .from("oxapay_deposits")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle();

    // Static-link fallback
    if ((!dep || !dep.user_id) && (status === "paid" || status === "confirmed") && payerEmail) {
      const amt = paidAmount || 0;
      const plans: Array<{ plan: string; usd: number }> = [
        { plan: "monthly", usd: 15 },
        { plan: "yearly", usd: 99 },
        { plan: "lifetime", usd: 250 },
      ];
      const matched = plans.find((p) => Math.abs(amt - p.usd) <= Math.max(1, p.usd * 0.05));
      if (!matched) {
        await logActivity({ event: "static_link_no_plan_match", ok: false, order_id: orderId, provider_status: status, amount_usd: amt, http_status: 400, message: `no plan for amount ${amt}`, payload });
        return json({ ok: false, error: "amount does not match any plan" }, 400);
      }

      const { data: prof } = await supabase
        .from("profiles")
        .select("user_id, email")
        .ilike("email", payerEmail.trim())
        .maybeSingle();

      if (!prof?.user_id) {
        await supabase.from("oxapay_deposits").upsert({
          order_id: orderId,
          purpose: "subscription",
          plan_type: matched.plan,
          amount_usd: matched.usd,
          email: payerEmail,
          track_id: trackId ? String(trackId) : null,
          webhook_payload: payload,
          status: "unmatched_email",
          credited: false,
        }, { onConflict: "order_id" });
        await logActivity({ event: "static_link_email_not_found", ok: false, order_id: orderId, plan_type: matched.plan, purpose: "subscription", amount_usd: matched.usd, provider_status: status, http_status: 404, message: `no user for email ${payerEmail}`, payload });
        return json({ ok: false, error: "user email not found" }, 404);
      }

      const { data: upserted, error: upErr } = await supabase.from("oxapay_deposits").upsert({
        order_id: orderId,
        user_id: prof.user_id,
        purpose: "subscription",
        plan_type: matched.plan,
        amount_usd: matched.usd,
        email: payerEmail,
        track_id: trackId ? String(trackId) : null,
        webhook_payload: payload,
        status: "paid",
        credited: false,
      }, { onConflict: "order_id" }).select("*").maybeSingle();

      if (upErr || !upserted) {
        await logActivity({ event: "static_link_upsert_failed", ok: false, order_id: orderId, user_id: prof.user_id, http_status: 500, message: upErr?.message || "upsert failed", payload });
        return json({ ok: false, error: upErr?.message || "upsert failed" }, 500);
      }
      dep = upserted;
      await logActivity({ event: "static_link_matched", order_id: orderId, user_id: prof.user_id, plan_type: matched.plan, purpose: "subscription", amount_usd: matched.usd, provider_status: status, message: `matched by email ${payerEmail}` });
    }

    if (fetchErr || !dep) {
      await logActivity({ event: "deposit_not_found", ok: false, order_id: orderId, provider_status: status, http_status: 404, message: fetchErr?.message || "deposit row missing", payload });
      return json({ ok: false, error: "deposit not found" }, 404);
    }

    await supabase.from("oxapay_deposits")
      .update({ webhook_payload: payload, track_id: trackId ? String(trackId) : dep.track_id })
      .eq("order_id", orderId);

    if (status === "expired") {
      await supabase.from("oxapay_deposits").update({ status: "expired" }).eq("order_id", orderId);
      await logActivity({ event: "invoice_expired", order_id: orderId, user_id: dep.user_id, plan_type: dep.plan_type, purpose: dep.purpose, amount_usd: Number(dep.amount_usd), provider_status: status, message: "invoice expired" });
      return json({ ok: true, status: "expired" });
    }

    if (!(status === "paid" || status === "confirmed")) {
      await logActivity({ event: "status_update", order_id: orderId, user_id: dep.user_id, plan_type: dep.plan_type, purpose: dep.purpose, amount_usd: Number(dep.amount_usd), provider_status: status, message: `waiting/confirming: ${status}` });
      return json({ ok: true, status });
    }

    if (dep.credited) {
      await logActivity({ event: "duplicate_paid_webhook", order_id: orderId, user_id: dep.user_id, plan_type: dep.plan_type, purpose: dep.purpose, amount_usd: Number(dep.amount_usd), provider_status: status, message: "already credited" });
      return json({ ok: true, duplicate: true });
    }

    // === SECURITY: never trust the webhook payload. Always re-verify with
    // OxaPay's own API using the track_id before crediting anything.
    // This blocks forged webhook POSTs from crediting a wallet or activating
    // a subscription without a real payment.
    const verifyTrackId = trackId ? String(trackId) : (dep.track_id ? String(dep.track_id) : "");
    if (!verifyTrackId) {
      await logActivity({ event: "verify_no_track_id", ok: false, order_id: orderId, user_id: dep.user_id, purpose: dep.purpose, http_status: 400, message: "no track_id to verify", payload });
      await recordSecurityEvent(supabase, {
        category: "webhook_missing_field",
        source: "oxapay-webhook",
        reason: "no track_id available to re-verify payment",
        provider: "oxapay",
        order_id: orderId,
        user_id: dep.user_id,
        http_status: 400,
        request: req,
        payload,
      });
      return json({ ok: false, error: "missing track_id" }, 400);
    }
    if (!OXA_API_KEY) {
      await logActivity({ event: "verify_no_api_key", ok: false, order_id: orderId, user_id: dep.user_id, http_status: 500, message: "OXAPAY_MERCHANT_API_KEY not configured" });
      return json({ ok: false, error: "server misconfigured" }, 500);
    }
    const verified = await verifyWithProvider(OXA_API_KEY, verifyTrackId);
    if (!verified.ok || !(verified.status === "paid" || verified.status === "confirmed")) {
      await logActivity({ event: "verify_failed", ok: false, order_id: orderId, user_id: dep.user_id, purpose: dep.purpose, provider_status: verified.status, http_status: 400, message: `provider did not confirm payment (got '${verified.status}')`, payload: verified.raw });
      await recordSecurityEvent(supabase, {
        category: "webhook_forgery",
        source: "oxapay-webhook",
        reason: `provider did not confirm payment (got '${verified.status}')`,
        provider: "oxapay",
        order_id: orderId,
        track_id: verifyTrackId,
        user_id: dep.user_id,
        http_status: 400,
        request: req,
        payload,
        metadata: { claimed_status: status, provider_status: verified.status, provider_raw: verified.raw },
      });
      return json({ ok: false, error: "provider did not confirm payment", provider_status: verified.status }, 400);
    }

    const expectedUsd = Number(dep.amount_usd);
    if (verified.paidAmount > 0 && verified.paidAmount < expectedUsd * 0.99) {
      await logActivity({ event: "verify_underpaid", ok: false, order_id: orderId, user_id: dep.user_id, purpose: dep.purpose, amount_usd: expectedUsd, http_status: 400, message: `underpaid: expected ${expectedUsd}, got ${verified.paidAmount}`, payload: verified.raw });
      await recordSecurityEvent(supabase, {
        category: "webhook_forgery",
        source: "oxapay-webhook",
        reason: `underpaid: expected ${expectedUsd}, got ${verified.paidAmount}`,
        provider: "oxapay",
        order_id: orderId,
        track_id: verifyTrackId,
        user_id: dep.user_id,
        http_status: 400,
        request: req,
        payload,
        metadata: { expected_usd: expectedUsd, paid_amount: verified.paidAmount },
      });
      return json({ ok: false, error: "underpaid" }, 400);
    }


    const creditUsd = expectedUsd;


    if (dep.purpose === "wallet") {
      const { data: res, error: rpcErr } = await supabase.rpc("credit_wallet_oxapay", {
        p_user_id: dep.user_id,
        p_order_id: orderId,
        p_amount_usd: creditUsd,
        p_track_id: trackId || null,
      });
      if (rpcErr) {
        await logActivity({ event: "wallet_credit_failed", ok: false, order_id: orderId, user_id: dep.user_id, purpose: "wallet", amount_usd: creditUsd, provider_status: status, http_status: 500, message: rpcErr.message, payload });
        return json({ ok: false, error: rpcErr.message }, 500);
      }
      await logActivity({ event: "wallet_credited", order_id: orderId, user_id: dep.user_id, purpose: "wallet", amount_usd: creditUsd, provider_status: status, message: "wallet credited", payload: res });
      await finalizeWebhookEvent(supabase, webhookEventId, { outcome: "wallet_credited", http_status: 200 });
      const { data: profile } = await supabase.from("profiles").select("email, full_name").eq("user_id", dep.user_id).maybeSingle();
      await notifyAdminTelegram(
        `✅ <b>OxaPay — Wallet Credited</b>\n` +
        `User: <b>${escapeTelegramHtml(profile?.full_name)}</b>\n` +
        `Email: <code>${escapeTelegramHtml(profile?.email || dep.email)}</code>\n` +
        `Amount: <b>$${creditUsd.toFixed(2)}</b>\n` +
        `Order ID: <code>${escapeTelegramHtml(orderId)}</code>\n` +
        `Track ID: <code>${escapeTelegramHtml(verifyTrackId)}</code>`,
      );
      return json({ ok: true, result: res });
    }

    if (dep.purpose === "subscription") {
      const { data: res, error: rpcErr } = await supabase.rpc("activate_subscription_oxapay", {
        p_user_id: dep.user_id,
        p_order_id: orderId,
        p_plan: dep.plan_type,
        p_amount_usd: creditUsd,
        p_track_id: trackId || null,
      });
      if (rpcErr) {
        await logActivity({ event: "subscription_activate_failed", ok: false, order_id: orderId, user_id: dep.user_id, plan_type: dep.plan_type, purpose: "subscription", amount_usd: creditUsd, provider_status: status, http_status: 500, message: rpcErr.message, payload });
        return json({ ok: false, error: rpcErr.message }, 500);
      }
      await logActivity({ event: "subscription_activated", order_id: orderId, user_id: dep.user_id, plan_type: dep.plan_type, purpose: "subscription", amount_usd: creditUsd, provider_status: status, message: "subscription activated", payload: res });
      await finalizeWebhookEvent(supabase, webhookEventId, { outcome: "subscription_activated", http_status: 200 });
      const { data: profile } = await supabase.from("profiles").select("email, full_name").eq("user_id", dep.user_id).maybeSingle();
      await notifyAdminTelegram(
        `✅ <b>OxaPay — Subscription Activated</b>\n` +
        `User: <b>${escapeTelegramHtml(profile?.full_name)}</b>\n` +
        `Email: <code>${escapeTelegramHtml(profile?.email || dep.email)}</code>\n` +
        `Plan: <b>${escapeTelegramHtml(dep.plan_type)}</b>\n` +
        `Amount: <b>$${creditUsd.toFixed(2)}</b>\n` +
        `Order ID: <code>${escapeTelegramHtml(orderId)}</code>`,
      );
      return json({ ok: true, result: res });
    }

    await logActivity({ event: "unknown_purpose", ok: false, order_id: orderId, user_id: dep.user_id, purpose: dep.purpose, provider_status: status, message: "purpose not recognized" });
    return json({ ok: true, ignored: true });
  } catch (e: any) {
    console.error("oxapay-webhook error", e);
    try {
      await supabase.from("oxapay_activity_log").insert({
        source: "webhook",
        event: "unhandled_exception",
        ok: false,
        http_status: 500,
        message: e?.message || "Internal error",
      });
    } catch {}
    await recordSecurityEvent(supabase, {
      category: "webhook_processing_failure",
      source: "oxapay-webhook",
      reason: `unhandled exception: ${e?.message || "Internal error"}`,
      provider: "oxapay",
      http_status: 500,
      request: req,
      metadata: { stack: e?.stack?.slice(0, 500) },
    });
    return json({ ok: false, error: e?.message || "Internal error" }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
