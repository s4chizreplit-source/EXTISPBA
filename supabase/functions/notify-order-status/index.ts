// User-facing Telegram notification: sends a message to the caller's linked Telegram chat
// about one of their own engagement orders. Auth required (user JWT).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import { notifyUserTelegram, statusEmoji } from "../_shared/notify.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error } = await admin.auth.getUser(token);
    if (error || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { engagement_order_id, status } = await req.json();
    if (!engagement_order_id || !status) {
      return new Response(JSON.stringify({ error: "engagement_order_id and status required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: o } = await admin
      .from("engagement_orders")
      .select("user_id, order_number, link")
      .eq("id", engagement_order_id)
      .maybeSingle();
    if (!o || o.user_id !== user.id) {
      return new Response(JSON.stringify({ error: "Not authorized" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const label: Record<string, string> = {
      processing: "Processing started",
      completed: "Delivered ✅",
      partial: "Partially delivered",
      failed: "Failed",
      cancelled: "Cancelled",
    };
    await notifyUserTelegram(
      admin,
      o.user_id,
      `${statusEmoji(status)} <b>Order #${o.order_number}</b>\n${label[status] ?? status}\nLink: <code>${o.link ?? ""}</code>`,
    );

    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
