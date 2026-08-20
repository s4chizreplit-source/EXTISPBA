// Cron-able: scans completed engagement items + orders with auto_refill_enabled,
// computes drop% from organic_run_schedule provider_remains, fires a top-up order if drop >= threshold.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const results: Record<string, unknown>[] = [];

  try {
    // 1) Engagement items: completed, auto-refill on, under max, last_refill > 1h ago
    const { data: items } = await sb
      .from("engagement_order_items")
      .select(`
        id, engagement_order_id, service_id, quantity, price, auto_refill_threshold_pct,
        auto_refill_count, auto_refill_max, last_refill_at, status,
        engagement_orders!inner(user_id, link)
      `)
      .eq("auto_refill_enabled", true)
      .in("status", ["completed", "partial"])
      .limit(50);

    for (const it of items || []) {
      try {
        const refillCount = it.auto_refill_count || 0;
        const maxRefill = it.auto_refill_max || 3;
        if (refillCount >= maxRefill) continue;

        // 1h cooldown
        if (it.last_refill_at) {
          const since = Date.now() - new Date(it.last_refill_at).getTime();
          if (since < 60 * 60 * 1000) continue;
        }

        // Fetch runs to compute drop
        const { data: runs } = await sb
          .from("organic_run_schedule")
          .select("provider_start_count, provider_remains, quantity_to_send, status")
          .eq("engagement_order_item_id", it.id)
          .eq("status", "completed");

        let totalSent = 0;
        let totalDelivered = 0;
        for (const r of runs || []) {
          const sent = r.quantity_to_send || 0;
          const remains = r.provider_remains ?? 0;
          totalSent += sent;
          totalDelivered += Math.max(0, sent - remains);
        }
        if (totalSent === 0) continue;

        const dropPct = ((totalSent - totalDelivered) / totalSent) * 100;
        const threshold = it.auto_refill_threshold_pct || 10;

        if (dropPct < threshold) {
          results.push({ item_id: it.id, dropPct, skipped: "below threshold" });
          continue;
        }

        const refillQty = Math.max(10, Math.ceil(totalSent - totalDelivered));
        const userId = (it as { engagement_orders: { user_id: string; link: string } }).engagement_orders.user_id;
        const link = (it as { engagement_orders: { link: string } }).engagement_orders.link;
        const pricePerK = it.quantity > 0 ? (Number(it.price) / it.quantity) * 1000 : 0;
        const refillPrice = Number(((refillQty / 1000) * pricePerK).toFixed(4));

        // Check wallet
        const { data: wal } = await sb.from("wallets").select("balance").eq("user_id", userId).single();
        if (!wal || Number(wal.balance) < refillPrice) {
          results.push({ item_id: it.id, dropPct, skipped: "low balance" });
          continue;
        }

        // Insert refill order
        const { data: newOrder, error: oErr } = await sb.from("orders").insert({
          user_id: userId,
          service_id: it.service_id,
          link,
          quantity: refillQty,
          price: refillPrice,
          status: "pending",
        }).select("id").single();

        if (oErr) {
          results.push({ item_id: it.id, error: oErr.message });
          continue;
        }

        // Deduct wallet
        const newBal = Number(wal.balance) - refillPrice;
        await sb.from("wallets").update({ balance: newBal }).eq("user_id", userId);
        await sb.from("transactions").insert({
          user_id: userId,
          type: "order",
          amount: -refillPrice,
          balance_after: newBal,
          status: "completed",
          payment_method: "wallet",
          order_id: newOrder.id,
          description: `Auto-refill (drop ${dropPct.toFixed(1)}%)`,
        });

        // Mark
        await sb.from("engagement_order_items").update({
          auto_refill_count: refillCount + 1,
          last_refill_at: new Date().toISOString(),
        }).eq("id", it.id);

        // Trigger place-order
        await sb.functions.invoke("place-order", {
          body: { orderId: newOrder.id },
        }).catch(() => {});

        results.push({ item_id: it.id, refilled: refillQty, dropPct: Number(dropPct.toFixed(2)) });
      } catch (e) {
        results.push({ item_id: it.id, error: String(e) });
      }
    }

    return new Response(JSON.stringify({ success: true, processed: results.length, results }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
