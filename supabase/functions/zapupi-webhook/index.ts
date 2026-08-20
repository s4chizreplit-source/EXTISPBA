import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { registerWebhookEvent, finalizeWebhookEvent } from "../_shared/webhook-idempotency.ts";
import { recordSecurityEvent } from "../_shared/security-audit.ts";
import { escapeTelegramHtml, notifyAdminTelegram } from "../_shared/admin-telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

const STATUS_URL = "https://pay.zapupi.com/api/order-status";
const USD_RATE = 83.5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // Always 200 to webhook caller — never let provider retry on our internal errors
  try {
    const ZAP_KEY = Deno.env.get("ZAPUPI_ZAP_KEY");
    if (!ZAP_KEY) return ok({ received: true, note: "no key" });

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // Accept form or JSON
    let payload: Record<string, any> = {};
    const ct = req.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      payload = await req.json().catch(() => ({}));
    } else {
      const text = await req.text();
      const params = new URLSearchParams(text);
      for (const [k, v] of params) payload[k] = v;
      if (Object.keys(payload).length === 0) {
        try { payload = JSON.parse(text); } catch {/*noop*/}
      }
    }

    console.log("[zapupi-webhook] received", JSON.stringify(payload).slice(0, 500));

    const orderId =
      payload.order_id ||
      payload.client_txn_id ||
      payload.user_token ||
      payload.udf2 ||
      payload.remark2 ||
      payload.data?.order_id ||
      payload.data?.client_txn_id ||
      payload.data?.user_token ||
      payload.data?.udf2;

    if (!orderId) {
      console.warn("[zapupi-webhook] no order id in payload");
      return ok({ received: true });
    }

    // === Universal idempotency / replay protection ===
    // Fast-fail replayed deliveries before touching any wallet / subscription
    // rows. Duplicate = same (provider, order_id, payload_hash) OR same
    // (provider, track_id) previously recorded.
    const trackIdRaw =
      payload.txn_id ||
      payload.utr ||
      payload.upi_txn_id ||
      payload.data?.txn_id ||
      payload.data?.utr ||
      payload.data?.upi_txn_id ||
      null;
    let webhookEventId: string | undefined;
    try {
      const gate = await registerWebhookEvent(supabase, {
        provider: "zapupi",
        orderId: String(orderId),
        trackId: trackIdRaw ? String(trackIdRaw) : null,
        eventStatus: String(payload.status || payload.data?.status || "") || null,
        payload,
      });
      if (gate.duplicate) {
        console.warn(`[zapupi-webhook] duplicate delivery blocked (${gate.reason})`, orderId);
        await recordSecurityEvent(supabase, {
          category: "webhook_replay",
          source: "zapupi-webhook",
          reason: `duplicate delivery (${gate.reason})`,
          provider: "zapupi",
          order_id: String(orderId),
          track_id: trackIdRaw ? String(trackIdRaw) : null,
          http_status: 200,
          request: req,
          payload,
          metadata: { gate_reason: gate.reason },
        });
        return ok({ received: true, duplicate: true, reason: gate.reason });
      }
      webhookEventId = gate.eventId;
    } catch (e) {
      console.error("[zapupi-webhook] idempotency gate error", e);
    }

    const { data: deposit } = await supabase
      .from("zapupi_deposits")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle();

    // === Subscription flow (static pay link, no deposit row) ===
    // Frontend appends ?udf1=<user_id>&udf2=monthly_subscription to the pay link.
    const udf1 = payload.udf1 || payload.data?.udf1;
    const udf2 = String(payload.udf2 || payload.data?.udf2 || "").toLowerCase();
    const isSubscriptionPayload = !deposit && udf2 === "monthly_subscription" && udf1;

    if (isSubscriptionPayload) {
      // Provider must confirm the payment first (blocks forged webhooks).
      const verifiedSub = await verifyOrder(ZAP_KEY, orderId, payload);
      if (!verifiedSub.success) {
        await recordSecurityEvent(supabase, {
          category: "webhook_forgery",
          source: "zapupi-webhook",
          reason: "subscription webhook could not be verified with provider",
          provider: "zapupi",
          order_id: String(orderId),
          user_id: udf1 ? String(udf1) : null,
          http_status: 200,
          request: req,
          payload,
          metadata: { flow: "subscription", provider_raw: verifiedSub.raw },
        });
        return ok({ received: true, subscription: false, verified: false });
      }
      const paidInr = Number(verifiedSub.amount || 0);
      if (paidInr < 1000) {
        console.warn("[zapupi-webhook] subscription amount too low", paidInr);
        await recordSecurityEvent(supabase, {
          category: "webhook_forgery",
          source: "zapupi-webhook",
          reason: `subscription amount too low: ${paidInr}`,
          provider: "zapupi",
          order_id: String(orderId),
          user_id: udf1 ? String(udf1) : null,
          http_status: 200,
          request: req,
          payload,
          metadata: { flow: "subscription", paid_inr: paidInr },
        });
        return ok({ received: true, subscription: false, reason: "amount_low" });
      }

      const { data: prof } = await supabase
        .from("profiles")
        .select("user_id")
        .eq("user_id", udf1)
        .maybeSingle();
      if (!prof?.user_id) {
        console.warn("[zapupi-webhook] subscription udf1 not a real user", udf1);
        await recordSecurityEvent(supabase, {
          category: "webhook_forgery",
          source: "zapupi-webhook",
          reason: "subscription webhook udf1 does not match any real user",
          provider: "zapupi",
          order_id: String(orderId),
          user_id: udf1 ? String(udf1) : null,
          http_status: 200,
          request: req,
          payload,
          metadata: { flow: "subscription", spoofed_udf1: udf1 },
        });
        return ok({ received: true, subscription: false, reason: "unknown_user" });
      }


      // Idempotency: refuse to activate twice from the same provider order_id.
      // We piggyback on zapupi_deposits with a synthetic subscription row so
      // replays of the same webhook can never grant repeated benefits.
      const { data: existing } = await supabase
        .from("zapupi_deposits")
        .select("order_id, credited")
        .eq("order_id", orderId)
        .maybeSingle();
      if (existing?.credited) {
        return ok({ received: true, subscription: true, duplicate: true });
      }
      if (!existing) {
        await supabase.from("zapupi_deposits").insert({
          user_id: udf1,
          order_id: orderId,
          amount_inr: paidInr,
          status: "subscription",
          credited: false,
        });
      }

      const now = new Date();
      const expires = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

      // Deactivate any prior active subs then insert a fresh monthly one
      await supabase
        .from("subscriptions")
        .update({ status: "expired" })
        .eq("user_id", udf1)
        .eq("status", "active");

      const { error: subErr } = await supabase.from("subscriptions").insert({
        user_id: udf1,
        plan_type: "monthly",
        status: "active",
        activated_at: now.toISOString(),
        expires_at: expires.toISOString(),
        activated_by: udf1,
      });

      if (subErr) {
        console.error("[zapupi-webhook] subscription insert error", subErr);
        return ok({ received: true, subscription: false, error: subErr.message });
      }

      // Mark the synthetic deposit row as credited so replays short-circuit.
      await supabase
        .from("zapupi_deposits")
        .update({ credited: true, status: "subscription_activated" })
        .eq("order_id", orderId);

      console.log("[zapupi-webhook] subscription activated for", udf1);
      await finalizeWebhookEvent(supabase, webhookEventId, { outcome: "subscription_activated", http_status: 200 });
      const { data: subscriptionProfile } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("user_id", udf1)
        .maybeSingle();
      await notifyAdminTelegram(
        `✅ <b>ZapUPI — Subscription Activated</b>\n` +
        `User: <b>${escapeTelegramHtml(subscriptionProfile?.full_name)}</b>\n` +
        `Email: <code>${escapeTelegramHtml(subscriptionProfile?.email)}</code>\n` +
        `Plan: <b>Monthly</b>\n` +
        `Amount: <b>₹${paidInr.toFixed(2)}</b>\n` +
        `Order ID: <code>${escapeTelegramHtml(orderId)}</code>`,
      );
      return ok({ received: true, subscription: true, expires_at: expires.toISOString() });
    }


    if (!deposit) {
      console.warn("[zapupi-webhook] deposit not found for", orderId);
      return ok({ received: true });
    }


    if (deposit.credited) {
      return ok({ received: true, already_credited: true });
    }

    // Double-confirm with provider order-status API
    const verified = await verifyOrder(ZAP_KEY, orderId, payload);

    if (!verified.success) {
      if (verified.failed) {
        await supabase.from("zapupi_deposits")
          .update({ status: "failed", raw_response: verified.raw })
          .eq("order_id", orderId);
      }
      await recordSecurityEvent(supabase, {
        category: "webhook_forgery",
        source: "zapupi-webhook",
        reason: "wallet-credit webhook could not be verified with provider",
        provider: "zapupi",
        order_id: String(orderId),
        user_id: deposit.user_id,
        http_status: 200,
        request: req,
        payload,
        metadata: { flow: "wallet", provider_raw: verified.raw, failed: !!verified.failed },
      });
      return ok({ received: true, verified: false });
    }


    const inr = Number(verified.amount || deposit.amount_inr) || Number(deposit.amount_inr);
    const usd = Number((inr / USD_RATE).toFixed(4));

    const { error: rpcErr } = await supabase.rpc("credit_wallet_zapupi", {
      p_user_id: deposit.user_id,
      p_order_id: orderId,
      p_amount_usd: usd,
      p_amount_inr: inr,
      p_txn_id: verified.txnId || deposit.txn_id || null,
      p_utr: verified.utr || null,
    });

    if (rpcErr) {
      console.error("[zapupi-webhook] credit rpc error", rpcErr);
      await finalizeWebhookEvent(supabase, webhookEventId, { outcome: "wallet_credit_failed", http_status: 500, message: rpcErr.message });
      await recordSecurityEvent(supabase, {
        category: "webhook_processing_failure",
        source: "zapupi-webhook",
        reason: `wallet credit RPC failed: ${rpcErr.message}`,
        provider: "zapupi",
        order_id: orderId,
        http_status: 500,
        request: req,
        metadata: { stage: "credit_wallet_zapupi" },
      });
    } else {
      await finalizeWebhookEvent(supabase, webhookEventId, { outcome: "wallet_credited", http_status: 200 });
      const { data: walletProfile } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("user_id", deposit.user_id)
        .maybeSingle();
      await notifyAdminTelegram(
        `✅ <b>ZapUPI — Wallet Credited</b>\n` +
        `User: <b>${escapeTelegramHtml(walletProfile?.full_name)}</b>\n` +
        `Email: <code>${escapeTelegramHtml(walletProfile?.email)}</code>\n` +
        `Amount: <b>₹${inr.toFixed(2)}</b> ($${usd.toFixed(2)})\n` +
        `Order ID: <code>${escapeTelegramHtml(orderId)}</code>\n` +
        `UTR: <code>${escapeTelegramHtml(verified.utr || verified.txnId)}</code>`,
      );
    }

    return ok({ received: true, credited: !rpcErr });
  } catch (e: any) {
    console.error("[zapupi-webhook] error", e);
    await recordSecurityEvent(supabase, {
      category: "webhook_processing_failure",
      source: "zapupi-webhook",
      reason: `unhandled exception: ${e?.message || "Internal error"}`,
      provider: "zapupi",
      http_status: 500,
      request: req,
      metadata: { stack: e?.stack?.slice(0, 500) },
    });
    return ok({ received: true, error: e?.message });
  }
});

async function verifyOrder(
  zapKey: string,
  orderId: string,
  fallbackPayload: Record<string, any>
): Promise<{ success: boolean; failed?: boolean; amount?: number; txnId?: string; utr?: string; raw?: any }> {
  try {
    let resp = await fetch(STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ zap_key: zapKey, order_id: orderId }).toString(),
    });
    if (!resp.ok) {
      resp = await fetch(STATUS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zap_key: zapKey, order_id: orderId }),
      });
    }
    const raw = await resp.text();
    let data: any = null;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    console.log("[zapupi-webhook] verify resp", resp.status, raw.slice(0, 300));

    const node = data?.data || data?.result || data;
    const statusStr = String(
      node?.status || node?.payment_status || node?.txn_status || data?.status || ""
    ).toLowerCase();

    const isSuccess =
      statusStr === "success" ||
      statusStr === "completed" ||
      statusStr === "paid" ||
      statusStr === "settlement" ||
      data?.success === true ||
      node?.success === true;

    const isFailed =
      statusStr === "failed" || statusStr === "failure" || statusStr === "expired";

    if (isSuccess) {
      return {
        success: true,
        amount: Number(node?.amount || node?.txn_amount || fallbackPayload.amount),
        txnId: node?.utr || node?.txn_id || node?.upi_txn_id || fallbackPayload.txn_id,
        utr: node?.utr || node?.bank_ref || fallbackPayload.utr,
        raw: data,
      };
    }
    return { success: false, failed: isFailed, raw: data };
  } catch (e) {
    console.error("[zapupi-webhook] verify error", e);
    return { success: false };
  }
}

function ok(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
