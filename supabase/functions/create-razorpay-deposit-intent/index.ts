import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIXED_BUTTON_AMOUNTS_PAISE = new Set([5000, 10000, 20000, 50000, 100000]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "").trim();
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: authData, error: authError } = await supabase.auth.getUser(token);
    if (authError || !authData.user?.id || !authData.user?.email) {
      return new Response(JSON.stringify({ error: "Invalid user session" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const amountPaise = Number(body?.amount_paise);

    if (!Number.isInteger(amountPaise) || !FIXED_BUTTON_AMOUNTS_PAISE.has(amountPaise)) {
      return new Response(JSON.stringify({ error: "Unsupported amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const trustedEmail = authData.user.email.trim().toLowerCase();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const eventId = `wallet_intent:${crypto.randomUUID()}`;

    const { error: insertError } = await supabase
      .from("razorpay_webhook_events")
      .insert({
        event_id: eventId,
        event_type: "wallet_deposit_intent",
        payment_id: null,
        payload: {
          kind: "wallet_deposit_intent",
          provider: "razorpay",
          status: "pending",
          user_id: authData.user.id,
          email: trustedEmail,
          amount_paise: amountPaise,
          expires_at: expiresAt,
        },
      });

    if (insertError) throw insertError;

    return new Response(JSON.stringify({ ok: true, email: trustedEmail, amount_paise: amountPaise, expires_at: expiresAt }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("create-razorpay-deposit-intent error:", error);
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});