import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const OXAPAY_URL = "https://api.oxapay.com/v1/payment/invoice";
const USD_INR = 83.5;
const MIN_INR = 100;
const MAX_INR = 500000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const API_KEY = Deno.env.get("OXAPAY_MERCHANT_API_KEY");
    if (!API_KEY) return json({ error: "OxaPay not configured" }, 500);

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
    const amountInr = Math.floor(Number(body?.amount_inr) || 0);
    if (!amountInr || amountInr < MIN_INR) return json({ error: `Minimum is INR ${MIN_INR}` }, 400);
    if (amountInr > MAX_INR) return json({ error: `Maximum is INR ${MAX_INR}` }, 400);

    const amountUsd = +(amountInr / USD_INR).toFixed(2);
    if (amountUsd < 1) return json({ error: "Amount too small" }, 400);

    const orderId = `oxw_${user.id.slice(0, 8)}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const { error: insErr } = await supabase.from("oxapay_deposits").insert({
      user_id: user.id,
      purpose: "wallet",
      order_id: orderId,
      amount_usd: amountUsd,
      amount_inr: amountInr,
      status: "pending",
    });
    if (insErr) {
      console.error("insert error", insErr);
      return json({ error: "Could not create deposit" }, 500);
    }

    const origin =
      req.headers.get("origin") ||
      req.headers.get("referer")?.replace(/\/$/, "") ||
      "https://organicsmm.pro";

    const projectRef = Deno.env.get("SUPABASE_URL")!.replace("https://", "").split(".")[0];
    const callbackUrl = `https://${projectRef}.supabase.co/functions/v1/oxapay-webhook`;

    const payload = {
      amount: amountUsd,
      currency: "USD",
      lifetime: 30,
      fee_paid_by_payer: 1,
      under_paid_coverage: 0,
      to_currency: "USDT",
      auto_withdrawal: 0,
      mixed_payment: 0,
      callback_url: callbackUrl,
      return_url: `${origin}/wallet?deposit=success&order_id=${orderId}`,
      email: user.email || "",
      order_id: orderId,
      description: `Wallet top-up ₹${amountInr}`,
    };

    const upstream = await fetch(OXAPAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "merchant_api_key": API_KEY,
      },
      body: JSON.stringify(payload),
    });

    const raw = await upstream.text();
    let data: any = null;
    try { data = JSON.parse(raw); } catch { data = { raw }; }

    // OxaPay v1 returns { status: 200, data: { track_id, payment_url, ... } }
    const inner = data?.data || data;
    const trackId = inner?.track_id || inner?.trackId || null;
    const payLink = inner?.payment_url || inner?.paymentUrl || inner?.pay_link;

    if (!upstream.ok || !payLink) {
      console.error("oxapay create error", upstream.status, raw);
      await supabase.from("oxapay_deposits")
        .update({ status: "failed", raw_response: data })
        .eq("order_id", orderId);
      return json({ error: data?.message || data?.error?.message || "Payment provider error" }, 502);
    }

    await supabase.from("oxapay_deposits")
      .update({
        pay_link: payLink,
        track_id: trackId ? String(trackId) : null,
        raw_response: data,
      })
      .eq("order_id", orderId);

    return json({
      success: true,
      payment_url: payLink,
      order_id: orderId,
      amount_usd: amountUsd,
      amount_inr: amountInr,
    });
  } catch (e: any) {
    console.error("oxapay-create-wallet-topup error", e);
    return json({ error: e?.message || "Internal error" }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
