// TEMPORARY migration helper. Streams all public tables as NDJSON.
// Protected by the MIGRATION_TOKEN secret. DELETE THIS FUNCTION AFTER MIGRATION.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

// FK-safe order: parents before children.
const TABLE_ORDER = [
  "platform_settings",
  "profiles",
  "wallets",
  "user_roles",
  "subscriptions",
  "subscription_requests",
  "providers",
  "provider_accounts",
  "provider_balance_history",
  "services",
  "service_provider_mapping",
  "engagement_bundles",
  "bundle_items",
  "orders",
  "engagement_orders",
  "engagement_order_items",
  "organic_run_schedule",
  "engagement_health_history",
  "transactions",
  "deposits",
  "oxapay_deposits",
  "oxapay_activity_log",
  "zapupi_deposits",
  "razorpay_webhook_events",
  "webhook_events",
  "promo_codes",
  "promo_redemptions",
  "instagram_accounts",
  "instagram_media",
  "instagram_poll_state",
  "instagram_link_events",
  "apify_call_log",
  "chat_conversations",
  "chat_messages",
  "support_tickets",
  "telegram_engagement_links",
  "engagement_presets",
  "drip_feed_campaigns",
  "mass_order_batches",
  "mass_order_batch_items",
  "security_audit_log",
];

const PAGE = 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const token = Deno.env.get("MIGRATION_TOKEN");
  const auth = req.headers.get("authorization") ?? "";
  if (!token || auth !== `Bearer ${token}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );

  const url = new URL(req.url);
  if (url.searchParams.get("mode") === "manifest") {
    return new Response(JSON.stringify({ tables: TABLE_ORDER }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const only = url.searchParams.get("table");
  const tables = only ? TABLE_ORDER.filter((t) => t === only) : TABLE_ORDER;

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj: unknown) => controller.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
      for (const table of tables) {
        let from = 0;
        let total = 0;
        for (;;) {
          const { data, error } = await supabase
            .from(table)
            .select("*")
            .range(from, from + PAGE - 1);
          if (error) {
            send({ _type: "error", table, message: error.message });
            break;
          }
          if (!data || data.length === 0) break;
          for (const row of data) send({ _type: "row", table, row });
          total += data.length;
          if (data.length < PAGE) break;
          from += PAGE;
        }
        send({ _type: "table_done", table, rows: total });
      }
      send({ _type: "done" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { ...corsHeaders, "Content-Type": "application/x-ndjson" },
  });
});
