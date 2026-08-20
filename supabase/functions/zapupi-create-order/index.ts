import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const ZAPUPI_URL = "https://pay.zapupi.com/api/create-order";
const MIN_INR = 50;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const ZAP_KEY = Deno.env.get("ZAPUPI_ZAP_KEY");
    if (!ZAP_KEY) {
      return json({ error: "ZapUPI not configured" }, 500);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) return json({ error: "Please sign in again to continue (missing auth token)" }, 401);
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !user) {
      console.error("[zapupi-create-order] auth failed", userErr?.message);
      return json({ error: "Session expired — sign out and sign in again, then retry." }, 401);
    }


    const body = await req.json().catch(() => ({}));
    const amountInr = Math.floor(Number(body?.amount_inr) || 0);
    if (!amountInr || amountInr < MIN_INR) {
      return json({ error: `Minimum deposit is INR ${MIN_INR}` }, 400);
    }
    if (amountInr > 100000) {
      return json({ error: "Maximum deposit is INR 100000" }, 400);
    }

    const orderId = `zap_${user.id.slice(0, 8)}_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    // Insert pending row first (so webhook can find it even if create-order returns slowly)
    const { error: insErr } = await supabase.from("zapupi_deposits").insert({
      user_id: user.id,
      order_id: orderId,
      amount_inr: amountInr,
      status: "pending",
    });
    if (insErr) {
      console.error("[zapupi-create-order] insert error", insErr);
      return json({ error: "Could not create deposit" }, 500);
    }

    const origin =
      req.headers.get("origin") ||
      req.headers.get("referer")?.replace(/\/$/, "") ||
      "https://extipspanel.pro";

    // Public functions base: self-hosted stacks must expose a real public URL.
    const publicBase = (
      Deno.env.get("PUBLIC_FUNCTIONS_URL") ||
      Deno.env.get("SUPABASE_URL") ||
      ""
    ).replace(/\/$/, "");
    const webhookUrl = `${publicBase}/functions/v1/zapupi-webhook`;

    const payload: Record<string, string> = {
      zap_key: ZAP_KEY,
      order_id: orderId,
      amount: String(amountInr),
      customer_mobile: "9999999999",
      remark: `Wallet Top-up | ${user.id}`,
      webhook_url: webhookUrl,
      success_url: `${origin}/wallet?deposit=success&order_id=${orderId}`,
      failed_url: `${origin}/wallet?deposit=failed&order_id=${orderId}`,
      timeout_url: `${origin}/wallet?deposit=timeout&order_id=${orderId}`,
    };

    // ZapUPI expects form-encoded params. Try form first, fall back to JSON.
    async function callUpstream(mode: "form" | "json") {
      const res = await fetch(ZAPUPI_URL, {
        method: "POST",
        headers:
          mode === "form"
            ? { "Content-Type": "application/x-www-form-urlencoded" }
            : { "Content-Type": "application/json" },
        body:
          mode === "form"
            ? new URLSearchParams(payload).toString()
            : JSON.stringify(payload),
      });
      const text = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
      return { res, text, parsed };
    }

    const isOk = (res: Response, d: any) => {
      const s = String(d?.status || "").toLowerCase();
      return res.ok && (s === "success" || s === "true" || d?.status === true || d?.success === true);
    };

    let attempt = await callUpstream("form");
    if (!isOk(attempt.res, attempt.parsed)) {
      console.error("[zapupi-create-order] form attempt failed", attempt.res.status, attempt.text.slice(0, 400));
      const jsonAttempt = await callUpstream("json");
      if (isOk(jsonAttempt.res, jsonAttempt.parsed)) attempt = jsonAttempt;
      else {
        console.error("[zapupi-create-order] json attempt failed", jsonAttempt.res.status, jsonAttempt.text.slice(0, 400));
        const d = jsonAttempt.parsed;
        await supabase.from("zapupi_deposits")
          .update({ status: "failed", raw_response: d })
          .eq("order_id", orderId);
        return json({
          error: d?.message || d?.msg || d?.error || `Payment provider error (${jsonAttempt.res.status})`,
        }, 502);
      }
    }

    const data = attempt.parsed;


    const paymentUrl =
      data?.payment_url ||
      data?.data?.payment_url ||
      data?.result?.payment_url ||
      data?.data?.url ||
      data?.url;
    const upstreamOrder =
      data?.order_id || data?.data?.order_id || data?.data?.id || null;

    if (!paymentUrl) {
      console.error("[zapupi-create-order] no payment_url", data);
      await supabase.from("zapupi_deposits")
        .update({ status: "failed", raw_response: data })
        .eq("order_id", orderId);
      return json({ error: "No payment URL returned" }, 502);
    }

    await supabase.from("zapupi_deposits")
      .update({
        payment_url: paymentUrl,
        txn_id: upstreamOrder ? String(upstreamOrder) : null,
        raw_response: data,
      })
      .eq("order_id", orderId);

    return json({
      success: true,
      payment_url: paymentUrl,
      order_id: orderId,
      amount_inr: amountInr,
    });
  } catch (e: any) {
    console.error("[zapupi-create-order] error", e);
    return json({ error: e?.message || "Internal error" }, 500);
  }
});

function json(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
