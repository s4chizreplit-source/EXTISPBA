import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { escapeTelegramHtml, notifyAdminTelegram } from "../_shared/admin-telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const STATUS_URL = "https://pay.zapupi.com/api/order-status";
const USD_RATE = 83.5;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const ZAP_KEY = Deno.env.get("ZAPUPI_ZAP_KEY");
    if (!ZAP_KEY) return json({ error: "ZapUPI not configured" }, 500);

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: userErr } = await supabase.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.order_id || "").trim();
    if (!orderId) return json({ error: "order_id required" }, 400);

    const { data: deposit } = await supabase
      .from("zapupi_deposits")
      .select("*")
      .eq("order_id", orderId)
      .eq("user_id", user.id)
      .maybeSingle();

    if (!deposit) return json({ error: "Deposit not found" }, 404);

    if (deposit.credited) {
      return json({ status: "success", credited: true, already: true });
    }

    // Query provider (ZapUPI expects form-encoded; retry as JSON if needed)
    let resp = await fetch(STATUS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ zap_key: ZAP_KEY, order_id: orderId }).toString(),
    });
    if (!resp.ok) {
      resp = await fetch(STATUS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ zap_key: ZAP_KEY, order_id: orderId }),
      });
    }
    const raw = await resp.text();
    let data: any = null;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

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
      const inr = Number(node?.amount || node?.txn_amount || deposit.amount_inr) || Number(deposit.amount_inr);
      const usd = Number((inr / USD_RATE).toFixed(4));
      const txnId = node?.utr || node?.txn_id || node?.upi_txn_id || deposit.txn_id || null;
      const utr = node?.utr || node?.bank_ref || null;

      const { data: rpcResult, error: rpcErr } = await supabase.rpc("credit_wallet_zapupi", {
        p_user_id: deposit.user_id,
        p_order_id: orderId,
        p_amount_usd: usd,
        p_amount_inr: inr,
        p_txn_id: txnId,
        p_utr: utr,
      });
      if (rpcErr) {
        console.error("[zapupi-sync] credit rpc error", rpcErr);
        return json({ status: "pending", error: rpcErr.message });
      }
      const { data: profile } = await supabase
        .from("profiles")
        .select("email, full_name")
        .eq("user_id", deposit.user_id)
        .maybeSingle();
      await notifyAdminTelegram(
        `✅ <b>ZapUPI — Wallet Credited</b>\n` +
        `User: <b>${escapeTelegramHtml(profile?.full_name)}</b>\n` +
        `Email: <code>${escapeTelegramHtml(profile?.email)}</code>\n` +
        `Amount: <b>₹${inr.toFixed(2)}</b> ($${usd.toFixed(2)})\n` +
        `Order ID: <code>${escapeTelegramHtml(orderId)}</code>\n` +
        `UTR: <code>${escapeTelegramHtml(utr || txnId)}</code>`,
      );
      return json({ status: "success", credited: true, result: rpcResult });
    }

    if (isFailed) {
      await supabase.from("zapupi_deposits")
        .update({ status: "failed", raw_response: data })
        .eq("order_id", orderId);
      return json({ status: "failed" });
    }

    return json({ status: "pending" });
  } catch (e: any) {
    console.error("[zapupi-sync] error", e);
    return json({ error: e?.message || "Internal error" }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
