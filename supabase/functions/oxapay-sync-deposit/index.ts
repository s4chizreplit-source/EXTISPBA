import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { escapeTelegramHtml, notifyAdminTelegram } from "../_shared/admin-telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OXAPAY_INFO = "https://api.oxapay.com/v1/payment/";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  async function logActivity(entry: Record<string, any>) {
    try {
      await supabase.from("oxapay_activity_log").insert({
        source: "poller",
        ok: true,
        ...entry,
      });
    } catch (e) {
      console.error("log insert failed", e);
    }
  }

  try {
    const API_KEY = Deno.env.get("OXAPAY_MERCHANT_API_KEY");
    if (!API_KEY) {
      await logActivity({ event: "missing_api_key", ok: false, http_status: 500, message: "OXAPAY_MERCHANT_API_KEY not configured" });
      return json({ error: "OxaPay not configured" }, 500);
    }

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: userErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.order_id || "").trim();
    if (!orderId) return json({ error: "order_id required" }, 400);

    const { data: dep, error: fErr } = await supabase
      .from("oxapay_deposits")
      .select("*")
      .eq("order_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (fErr || !dep) {
      await logActivity({ event: "deposit_not_found", ok: false, order_id: orderId, user_id: user.id, http_status: 404, message: fErr?.message || "not found" });
      return json({ error: "deposit not found" }, 404);
    }

    if (dep.credited) {
      await logActivity({ event: "already_credited", order_id: orderId, user_id: user.id, purpose: dep.purpose, plan_type: dep.plan_type, amount_usd: Number(dep.amount_usd), message: "poll after credit" });
      return json({ credited: true, status: "success" });
    }

    if (dep.track_id) {
      const resp = await fetch(`${OXAPAY_INFO}${dep.track_id}`, {
        headers: { "merchant_api_key": API_KEY },
      });
      const raw = await resp.text();
      let data: any = null;
      try { data = JSON.parse(raw); } catch { data = { raw }; }
      const inner = data?.data || data;
      const status = String(inner?.status || "").toLowerCase();

      if (status === "paid" || status === "confirmed") {
        if (dep.purpose === "wallet") {
          const { error: rpcErr } = await supabase.rpc("credit_wallet_oxapay", {
            p_user_id: dep.user_id,
            p_order_id: orderId,
            p_amount_usd: Number(dep.amount_usd),
            p_track_id: dep.track_id,
          });
          if (rpcErr) {
            await logActivity({ event: "wallet_credit_failed", ok: false, order_id: orderId, user_id: user.id, purpose: "wallet", amount_usd: Number(dep.amount_usd), provider_status: status, http_status: 500, message: rpcErr.message });
            return json({ error: rpcErr.message }, 500);
          }
          await logActivity({ event: "wallet_credited", order_id: orderId, user_id: user.id, purpose: "wallet", amount_usd: Number(dep.amount_usd), provider_status: status, message: "poller credited wallet" });
          await notifyAdminTelegram(
            `✅ <b>OxaPay — Wallet Credited</b>\n` +
            `Email: <code>${escapeTelegramHtml(user.email || dep.email)}</code>\n` +
            `Amount: <b>$${Number(dep.amount_usd).toFixed(2)}</b>\n` +
            `Order ID: <code>${escapeTelegramHtml(orderId)}</code>\n` +
            `Track ID: <code>${escapeTelegramHtml(dep.track_id)}</code>`,
          );
        } else if (dep.purpose === "subscription") {
          const { error: rpcErr } = await supabase.rpc("activate_subscription_oxapay", {
            p_user_id: dep.user_id,
            p_order_id: orderId,
            p_plan: dep.plan_type,
            p_amount_usd: Number(dep.amount_usd),
            p_track_id: dep.track_id,
          });
          if (rpcErr) {
            await logActivity({ event: "subscription_activate_failed", ok: false, order_id: orderId, user_id: user.id, plan_type: dep.plan_type, purpose: "subscription", amount_usd: Number(dep.amount_usd), provider_status: status, http_status: 500, message: rpcErr.message });
            return json({ error: rpcErr.message }, 500);
          }
          await logActivity({ event: "subscription_activated", order_id: orderId, user_id: user.id, plan_type: dep.plan_type, purpose: "subscription", amount_usd: Number(dep.amount_usd), provider_status: status, message: "poller activated subscription" });
          await notifyAdminTelegram(
            `✅ <b>OxaPay — Subscription Activated</b>\n` +
            `Email: <code>${escapeTelegramHtml(user.email || dep.email)}</code>\n` +
            `Plan: <b>${escapeTelegramHtml(dep.plan_type)}</b>\n` +
            `Amount: <b>$${Number(dep.amount_usd).toFixed(2)}</b>\n` +
            `Order ID: <code>${escapeTelegramHtml(orderId)}</code>`,
          );
        }
        return json({ credited: true, status: "success" });
      }
      if (status === "expired") {
        await supabase.from("oxapay_deposits").update({ status: "expired" }).eq("order_id", orderId);
        await logActivity({ event: "invoice_expired", order_id: orderId, user_id: user.id, plan_type: dep.plan_type, purpose: dep.purpose, provider_status: status, message: "expired via poller" });
        return json({ status: "failed" });
      }
      await logActivity({ event: "poll_status", order_id: orderId, user_id: user.id, plan_type: dep.plan_type, purpose: dep.purpose, provider_status: status, message: `still ${status}` });
      return json({ status: "pending", provider_status: status });
    }

    await logActivity({ event: "no_track_id", ok: false, order_id: orderId, user_id: user.id, message: "deposit missing track_id" });
    return json({ status: dep.status });
  } catch (e: any) {
    console.error("oxapay-sync-deposit error", e);
    try {
      await supabase.from("oxapay_activity_log").insert({
        source: "poller",
        event: "unhandled_exception",
        ok: false,
        http_status: 500,
        message: e?.message || "Internal error",
      });
    } catch {}
    return json({ error: e?.message || "Internal error" }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
