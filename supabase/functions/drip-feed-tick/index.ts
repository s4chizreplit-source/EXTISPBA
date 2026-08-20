// Cron-able: fires due drip-feed campaigns, places one order per due campaign per tick
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
    const { data: due } = await sb
      .from("drip_feed_campaigns")
      .select("*")
      .eq("is_active", true)
      .lte("next_run_at", new Date().toISOString())
      .limit(25);

    for (const c of due || []) {
      try {
        if (c.runs_done >= c.total_runs) {
          await sb.from("drip_feed_campaigns").update({ is_active: false }).eq("id", c.id);
          continue;
        }

        // Get service price
        const { data: svc } = await sb.from("services").select("price").eq("id", c.service_id).single();
        if (!svc) {
          await sb.from("drip_feed_campaigns").update({
            last_error: "Service not found",
            runs_failed: (c.runs_failed || 0) + 1,
            next_run_at: new Date(Date.now() + c.interval_minutes * 60 * 1000).toISOString(),
          }).eq("id", c.id);
          continue;
        }

        // Global markup removed — services.price is the final per-1000 USD price set by admin.
        const finalPrice = Number(((c.qty_per_run / 1000) * Number(svc.price)).toFixed(4));

        // Check wallet
        const { data: wal } = await sb.from("wallets").select("balance").eq("user_id", c.user_id).single();
        if (!wal || Number(wal.balance) < finalPrice) {
          await sb.from("drip_feed_campaigns").update({
            last_error: "Insufficient balance — paused",
            is_active: false,
          }).eq("id", c.id);
          results.push({ id: c.id, skipped: "low balance, paused" });
          continue;
        }

        // Place order
        const { data: newOrder, error: oErr } = await sb.from("orders").insert({
          user_id: c.user_id,
          service_id: c.service_id,
          link: c.link,
          quantity: c.qty_per_run,
          price: finalPrice,
          status: "pending",
        }).select("id").single();

        if (oErr) {
          await sb.from("drip_feed_campaigns").update({
            last_error: oErr.message,
            runs_failed: (c.runs_failed || 0) + 1,
            next_run_at: new Date(Date.now() + c.interval_minutes * 60 * 1000).toISOString(),
          }).eq("id", c.id);
          continue;
        }

        // Deduct
        const newBal = Number(wal.balance) - finalPrice;
        await sb.from("wallets").update({ balance: newBal }).eq("user_id", c.user_id);
        await sb.from("transactions").insert({
          user_id: c.user_id,
          type: "order",
          amount: -finalPrice,
          balance_after: newBal,
          status: "completed",
          payment_method: "wallet",
          order_id: newOrder.id,
          description: `Drip-feed run ${c.runs_done + 1}/${c.total_runs}`,
        });

        const newDone = c.runs_done + 1;
        const stillActive = newDone < c.total_runs;
        await sb.from("drip_feed_campaigns").update({
          runs_done: newDone,
          last_order_id: newOrder.id,
          last_error: null,
          next_run_at: new Date(Date.now() + c.interval_minutes * 60 * 1000).toISOString(),
          is_active: stillActive,
        }).eq("id", c.id);

        await sb.functions.invoke("place-order", { body: { orderId: newOrder.id } }).catch(() => {});

        results.push({ id: c.id, fired: newOrder.id, run: `${newDone}/${c.total_runs}` });
      } catch (e) {
        results.push({ id: c.id, error: String(e) });
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
