// Central Instagram engagement order placer — used by web, poll, and Telegram bot.
// Input: { user_id?, link, views?, likes?, comments?, drip_minutes?, source? }
// If no user_id in body, uses caller JWT.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { notifyUserTelegram } from "../_shared/notify.ts";
import { assertPaymentEligible } from "../_shared/payment-eligibility.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

function extractShortcode(link: string): string | null {
  const m = link.match(/instagram\.com\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}




Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const link = String(body.link ?? "").trim();
    const views = Math.max(0, Math.floor(Number(body.views ?? 0)));
    const likes = Math.max(0, Math.floor(Number(body.likes ?? 0)));
    const comments = Math.max(0, Math.floor(Number(body.comments ?? 0)));
    const saves = Math.max(0, Math.floor(Number(body.saves ?? 0)));
    const shares = Math.max(0, Math.floor(Number(body.shares ?? 0)));
    const reposts = Math.max(0, Math.floor(Number(body.reposts ?? 0)));
    const drip_minutes = Math.max(0, Math.floor(Number(body.drip_minutes ?? 0)));
    const source = String(body.source ?? "web");

    if (!link || !/instagram\.com\//i.test(link)) {
      return new Response(JSON.stringify({ error: "Invalid Instagram link" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const totalReq = views + likes + comments + saves + shares + reposts;
    if (totalReq === 0) {
      return new Response(JSON.stringify({ error: "At least one engagement type must be > 0" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Resolve user — always require valid JWT; body.user_id only honored for service-role callers
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    let userId: string | null = null;
    if (token === SERVICE_KEY) {
      // Trusted internal caller (e.g. Telegram bot / cron) may specify user_id
      userId = body.user_id ? String(body.user_id) : null;
      if (!userId) {
        return new Response(JSON.stringify({ error: "user_id required for service calls" }), {
          status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    } else {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: authHeader } } });
      const { data: u } = await userClient.auth.getUser(token);
      userId = u?.user?.id ?? null;
      if (!userId) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }

    // Payment-eligibility gate: admin OR active verified subscription OR
    // at least one completed deposit from a real gateway.
    const eligibility = await assertPaymentEligible(admin, userId, { source: "instagram-place-engagement", request: req });
    if (!eligibility.ok) {
      return new Response(JSON.stringify({ error: eligibility.error }), {
        status: eligibility.status,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }


    // Load active IG bundle + items
    const { data: bundle } = await admin
      .from("engagement_bundles")
      .select("id,platform,is_active,bundle_items(engagement_type,service_id,price_per_k)")
      .eq("platform", "instagram")
      .eq("is_active", true)
      .maybeSingle();

    if (!bundle || !Array.isArray((bundle as any).bundle_items) || (bundle as any).bundle_items.length === 0) {
      return new Response(JSON.stringify({ error: "Instagram bundle not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const items = (bundle as any).bundle_items as Array<{ engagement_type: string; service_id: string; price_per_k: number | null }>;
    const byType: Record<string, { service_id: string; price_per_k: number }> = {};
    for (const it of items) byType[it.engagement_type] = { service_id: it.service_id, price_per_k: Number(it.price_per_k ?? 0) };

    // Markup
    const { data: mkRow } = await admin.rpc("get_public_markup");
    const markup = Number(mkRow ?? 0) / 100;

    const orderItems: Array<{ type: string; qty: number; service_id: string; price_usd: number }> = [];
    const push = (type: string, qty: number) => {
      if (qty <= 0) return;
      const cfg = byType[type];
      if (!cfg) return;
      const price_usd = Number(((qty / 1000) * cfg.price_per_k * (1 + markup)).toFixed(4));
      orderItems.push({ type, qty, service_id: cfg.service_id, price_usd });
    };
    push("views", views);
    push("likes", likes);
    push("comments", comments);
    push("saves", saves);
    push("shares", shares);
    push("reposts", reposts);

    if (orderItems.length === 0) {
      return new Response(JSON.stringify({ error: "No configured services for requested types (admin: add bundle_items for saves/shares/reposts)" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const totalUsd = Number(orderItems.reduce((s, it) => s + it.price_usd, 0).toFixed(4));
    const baseQty = orderItems.reduce((s, it) => s + it.qty, 0);

    // Debit wallet (idempotent per link+minute+source)
    const idem = `ig:${extractShortcode(link) ?? link}:${source}:${Math.floor(Date.now() / 60000)}`;
    const { data: debit, error: debitErr } = await admin.rpc("debit_wallet_for_order", {
      p_user_id: userId,
      p_amount: totalUsd,
      p_order_id: null,
      p_description: `Instagram engagement (${orderItems.map((i) => `${i.qty} ${i.type}`).join(", ")})`,
      p_idempotency_key: idem,
    });
    if (debitErr) {
      return new Response(JSON.stringify({ error: debitErr.message }), {
        status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Insert engagement_order + items
    const { data: order, error: orderErr } = await admin
      .from("engagement_orders")
      .insert({
        user_id: userId,
        bundle_id: (bundle as any).id,
        link,
        base_quantity: baseQty,
        total_price: totalUsd,
        status: "pending",
        is_organic_mode: true,
        peak_hours_enabled: true,
      })
      .select()
      .single();
    if (orderErr) throw orderErr;

    const itemRows = orderItems.map((it) => ({
      engagement_order_id: order.id,
      engagement_type: it.type,
      service_id: it.service_id,
      quantity: it.qty,
      price: it.price_usd,
      status: "pending",
      is_enabled: true,
      drip_interval: drip_minutes || null,
      drip_interval_unit: drip_minutes ? "minutes" : null,
    }));
    const { error: itemsErr } = await admin.from("engagement_order_items").insert(itemRows);
    if (itemsErr) throw itemsErr;

    // Schedule creation is part of a successful order. Self-hosted edge
    // runtimes may terminate detached work as soon as this response returns,
    // so wait for the scheduler and surface failures instead of confirming an
    // order that has no organic runs.
    const scheduleResponse = await fetch(`${SUPABASE_URL}/functions/v1/process-engagement-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
      body: JSON.stringify({ engagement_order_id: order.id }),
    });
    if (!scheduleResponse.ok) {
      const scheduleError = await scheduleResponse.text();
      console.error("process-engagement-order failed", scheduleResponse.status, scheduleError);
      await admin.from("engagement_orders").update({
        status: "failed",
        error_message: `Schedule creation failed: ${scheduleError.slice(0, 500)}`,
      }).eq("id", order.id);
      throw new Error(`Order schedule failed (${scheduleResponse.status})`);
    }

    // Send Telegram confirmation with order id (if user has linked)
    try {
      const inr = Number((totalUsd * 83.5).toFixed(2));
      const parts = orderItems.map((it) => `${it.type}:${it.qty}`).join(" · ");
      await notifyUserTelegram(
        admin,
        userId,
        `✅ <b>Order placed</b>\nID: <code>#${order.order_number}</code>\nLink: <code>${link}</code>\n${parts}\nCharged: ₹${inr}\nStatus: ⏳ pending`,
      );
    } catch (_) { /* noop */ }

    return new Response(
      JSON.stringify({ order_id: order.id, order_number: order.order_number, charged_usd: totalUsd, charged_inr: Number((totalUsd * 83.5).toFixed(2)), items: orderItems }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("instagram-place-engagement error", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
