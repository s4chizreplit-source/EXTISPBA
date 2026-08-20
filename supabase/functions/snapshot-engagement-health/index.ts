// Periodic snapshot of botting/health % for active engagement orders.
// Aggregates completed run quantities per engagement type, computes ratios,
// inserts a row in engagement_health_history, and updates engagement_orders.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const RATIO_BANDS = {
  likes:    { lowOk: 4,   highOk: 10,  lowDanger: 1,    highDanger: 20 },
  comments: { lowOk: 0.3, highOk: 1.5, lowDanger: 0.05, highDanger: 4  },
  shares:   { lowOk: 0.3, highOk: 2,   lowDanger: 0.02, highDanger: 5  },
  saves:    { lowOk: 0.3, highOk: 3,   lowDanger: 0.02, highDanger: 6  },
} as const;
type RatioKey = keyof typeof RATIO_BANDS;

function scoreRatio(pct: number, band: { lowOk: number; highOk: number; lowDanger: number; highDanger: number }) {
  if (pct >= band.lowOk && pct <= band.highOk) return 100;
  if (pct < band.lowOk) {
    if (pct <= band.lowDanger) return 0;
    return Math.round(((pct - band.lowDanger) / (band.lowOk - band.lowDanger)) * 100);
  }
  if (pct >= band.highDanger) return 0;
  return Math.round(((band.highDanger - pct) / (band.highDanger - band.highOk)) * 100);
}

// Map raw engagement_type strings to a normalized ratio bucket.
function bucketFor(type: string): RatioKey | "views" | "followers" | null {
  const t = (type || "").toLowerCase();
  if (t.includes("view") || t.includes("impression") || t.includes("reach") || t.includes("play")) return "views";
  if (t.includes("follow") || t.includes("subscriber") || t.includes("member")) return "followers";
  if (t.includes("like") || t.includes("reaction") || t.includes("upvote")) return "likes";
  if (t.includes("comment") || t.includes("reply")) return "comments";
  if (t.includes("share") || t.includes("repost") || t.includes("retweet")) return "shares";
  if (t.includes("save") || t.includes("bookmark")) return "saves";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Active engagement orders only
    const { data: orders, error: ordersErr } = await supabase
      .from("engagement_orders")
      .select("id")
      .in("status", ["pending", "processing", "in_progress", "active", "partial"]);
    if (ordersErr) throw ordersErr;

    let snapshots = 0;
    for (const o of orders ?? []) {
      // Items + their delivered quantities
      const { data: items } = await supabase
        .from("engagement_order_items")
        .select("id, engagement_type, quantity")
        .eq("engagement_order_id", o.id);
      if (!items?.length) continue;

      const itemIds = items.map((i) => i.id);
      const { data: runs } = await supabase
        .from("organic_run_schedule")
        .select("engagement_order_item_id, quantity_to_send, status")
        .in("engagement_order_item_id", itemIds)
        .eq("status", "completed");

      const delivered: Record<string, number> = {};
      for (const r of runs ?? []) {
        const key = r.engagement_order_item_id as string;
        delivered[key] = (delivered[key] ?? 0) + (r.quantity_to_send ?? 0);
      }

      const counts = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0, followers: 0 };
      const ratios: Record<string, number> = {};
      for (const it of items) {
        const b = bucketFor(it.engagement_type ?? "");
        if (!b) continue;
        counts[b] += delivered[it.id] ?? 0;
      }

      const views = counts.views;
      const checks: { key: RatioKey; score: number; pct: number }[] = [];
      (Object.keys(RATIO_BANDS) as RatioKey[]).forEach((k) => {
        if (views <= 0) return;
        if (counts[k] <= 0) return;
        const pct = (counts[k] / views) * 100;
        ratios[k] = pct;
        checks.push({ key: k, score: scoreRatio(pct, RATIO_BANDS[k]), pct });
      });

      const healthScore = checks.length
        ? Math.round(checks.reduce((s, c) => s + c.score, 0) / checks.length)
        : 100;
      const bottingPct = 100 - healthScore;

      const warnings = checks
        .filter((c) => c.score < 60)
        .map((c) => ({ key: c.key, pct: Number(c.pct.toFixed(2)), score: c.score }));

      const { error: insErr } = await supabase.from("engagement_health_history").insert({
        engagement_order_id: o.id,
        health_score: healthScore,
        botting_percent: bottingPct,
        views_count: counts.views,
        likes_count: counts.likes,
        comments_count: counts.comments,
        shares_count: counts.shares,
        saves_count: counts.saves,
        followers_count: counts.followers,
        ratios,
        warnings,
      });
      if (insErr) {
        console.error("history insert err", o.id, insErr.message);
        continue;
      }

      await supabase
        .from("engagement_orders")
        .update({
          current_health_score: healthScore,
          current_botting_percent: bottingPct,
          last_health_check_at: new Date().toISOString(),
        })
        .eq("id", o.id);

      snapshots++;
    }

    return new Response(JSON.stringify({ ok: true, snapshots, scanned: orders?.length ?? 0 }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("snapshot-engagement-health error", e);
    return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
