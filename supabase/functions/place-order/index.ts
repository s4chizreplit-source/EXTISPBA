import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertPaymentEligible } from "../_shared/payment-eligibility.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Payment-eligibility gate: admin OR active verified subscription OR
    // at least one completed deposit from a real gateway.
    const eligibility = await assertPaymentEligible(supabaseAdmin, user.id, { source: "place-order", request: req });
    if (!eligibility.ok) {
      return new Response(JSON.stringify({ error: eligibility.error }), {
        status: eligibility.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    const body = await req.json();
    const { orderData, totalPrice, runs } = body;

    if (!orderData || typeof orderData !== "object" || !totalPrice || totalPrice <= 0) {
      return new Response(JSON.stringify({ error: "Invalid order data" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Allowlist: only accept known order fields from the client
    const serviceId = String(orderData.service_id || "");
    const link = String(orderData.link || "").slice(0, 2000);
    const quantity = Math.max(1, Math.floor(Number(orderData.quantity) || 0));
    if (!serviceId || !link || !quantity) {
      return new Response(JSON.stringify({ error: "service_id, link, and quantity are required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const sanitizedOrder: Record<string, unknown> = {
      service_id: serviceId,
      link,
      quantity,
      is_drip_feed: !!orderData.is_drip_feed,
      is_organic_mode: !!orderData.is_organic_mode,
      variance_percent: orderData.variance_percent != null
        ? Math.max(0, Math.min(100, Math.floor(Number(orderData.variance_percent)))) : 25,
      peak_hours_enabled: orderData.peak_hours_enabled !== false,
      drip_runs: orderData.drip_runs != null ? Math.max(1, Math.floor(Number(orderData.drip_runs))) : null,
      drip_interval: orderData.drip_interval != null ? Math.max(1, Math.floor(Number(orderData.drip_interval))) : null,
      drip_interval_unit: ["minutes", "hours", "days"].includes(orderData.drip_interval_unit)
        ? orderData.drip_interval_unit : null,
      drip_quantity_per_run: orderData.drip_quantity_per_run != null
        ? Math.max(1, Math.floor(Number(orderData.drip_quantity_per_run))) : null,
      auto_refill_enabled: !!orderData.auto_refill_enabled,
      auto_refill_threshold_pct: orderData.auto_refill_threshold_pct != null
        ? Math.max(0, Math.min(100, Math.floor(Number(orderData.auto_refill_threshold_pct)))) : 10,
      auto_refill_max: orderData.auto_refill_max != null
        ? Math.max(0, Math.min(10, Math.floor(Number(orderData.auto_refill_max)))) : 3,
      status: "pending",
      price: totalPrice,
    };

    // Server-side price verification
    const { data: svc, error: svcErr } = await supabaseAdmin
      .from("services").select("price, is_active").eq("id", serviceId).single();
    if (svcErr || !svc || !svc.is_active) {
      return new Response(JSON.stringify({ error: "Service not available" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const expectedPrice = (quantity / 1000) * Number(svc.price || 0);
    if (expectedPrice <= 0 || Math.abs(totalPrice - expectedPrice) / expectedPrice > 0.01) {
      return new Response(JSON.stringify({ error: "Price mismatch" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const service_name = orderData.service_name;

    // 1. Confirm the wallet exists. The authoritative balance check and debit
    // happen atomically below so simultaneous requests cannot overspend it.
    const { data: wallet, error: walletError } = await supabaseAdmin
      .from("wallets")
      .select("user_id")
      .eq("user_id", user.id)
      .single();

    if (walletError || !wallet) {
      return new Response(JSON.stringify({ error: "Wallet not found" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const duplicateWindowStart = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    const { data: recentDuplicateOrder } = await supabaseAdmin
      .from("orders")
      .select("id, order_number, status, created_at")
      .eq("user_id", user.id)
      .eq("service_id", serviceId)
      .eq("link", link)
      .eq("quantity", quantity)
      .gte("created_at", duplicateWindowStart)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentDuplicateOrder) {
      return new Response(JSON.stringify({
        success: true,
        duplicate_blocked: true,
        order_id: recentDuplicateOrder.id,
        order_number: recentDuplicateOrder.order_number,
        status: recentDuplicateOrder.status,
        message: "A similar order was just created, so a duplicate request was blocked.",
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Create order (sanitized fields only)
    const { data: order, error: orderError } = await supabaseAdmin
      .from("orders")
      .insert({
        ...sanitizedOrder,
        user_id: user.id,
      })
      .select()
      .single();

    if (orderError || !order) {
      return new Response(JSON.stringify({ error: `Failed to create order: ${orderError?.message}` }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Atomic debit: the database locks/updates the wallet in one statement.
    const { data: newBalance, error: debitError } = await supabaseAdmin.rpc(
      "debit_wallet_for_order",
      { p_user_id: user.id, p_amount: totalPrice },
    );

    if (debitError || newBalance == null) {
      // The order has not been paid, so remove it before returning an error.
      await supabaseAdmin.from("orders").delete().eq("id", order.id);
      const insufficient = debitError?.message?.includes("Insufficient balance");
      return new Response(JSON.stringify({
        error: insufficient ? "Insufficient balance" : "Failed to charge wallet",
      }), {
        status: insufficient ? 400 : 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 4. Record transaction
    const { error: txErr } = await supabaseAdmin.from("transactions").insert({
      user_id: user.id,
      type: "order_payment",
      amount: totalPrice,
      balance_after: newBalance,
      order_id: order.id,
      description: `Order #${order.order_number} - ${service_name || 'Service Order'}`,
      status: "completed",
    });

    if (txErr) console.error("Transaction insert error:", txErr);

    // 5. Insert organic run schedule if provided (sanitized)
    if (Array.isArray(runs) && runs.length > 0) {
      const runEntries = runs.slice(0, 1000).map((run: any) => ({
        order_id: order.id,
        scheduled_at: run?.scheduled_at ? new Date(run.scheduled_at).toISOString() : new Date().toISOString(),
        quantity_to_send: Math.max(1, Math.floor(Number(run?.quantity_to_send) || 0)),
        base_quantity: Math.max(1, Math.floor(Number(run?.base_quantity ?? run?.quantity_to_send) || 0)),
        variance_applied: Number(run?.variance_applied ?? 0),
        peak_multiplier: Number(run?.peak_multiplier ?? 1),
        run_number: run?.run_number != null ? Math.max(1, Math.floor(Number(run.run_number))) : null,
        status: "pending",
      }));
      
      const { error: runErr } = await supabaseAdmin
        .from("organic_run_schedule")
        .insert(runEntries);
        
      if (runErr) console.error("Run schedule insert error:", runErr);
    }

    // 6. Trigger process-order for non-organic orders
    if (!sanitizedOrder.is_organic_mode) {
      try {
        await supabaseAdmin.functions.invoke("process-order", {
          body: { order_id: order.id },
        });
      } catch (e) {
        console.error("Failed to trigger process-order:", e);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      order_id: order.id,
      order_number: order.order_number,
      new_balance: newBalance,
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err: any) {
    console.error("place-order error:", err);
    return new Response(JSON.stringify({ error: err.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
