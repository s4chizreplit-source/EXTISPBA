// E2E invariant checker for the engagement order pipeline.
// Read-only, returns aggregate counts only (no row IDs / no PII).
// Safe to call with anon key from automated tests.
//
// Checks:
//   1. bundle_items -> runs creation integrity
//   2. provider_order_id uniqueness
//   3. repeat dispatch prevention

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const results: Record<string, any> = {};

    // ---- 1. bundle_items -> runs creation integrity ----
    const { data: items, error: itemsErr } = await admin
      .from("engagement_order_items")
      .select(`
        id, quantity, service_id, engagement_type, status,
        engagement_order:engagement_order_id ( bundle_id ),
        runs:organic_run_schedule ( quantity_to_send )
      `)
      .in("status", ["pending", "processing", "completed", "partial"]);
    if (itemsErr) throw itemsErr;

    const { data: bundleItems, error: biErr } = await admin
      .from("bundle_items").select("bundle_id, service_id, engagement_type");
    if (biErr) throw biErr;
    const bundleMap = new Set(
      (bundleItems || []).map((b: any) => `${b.bundle_id}|${b.service_id}|${b.engagement_type}`),
    );

    let mismatchedRunSum = 0;
    let orphanedFromBundle = 0;
    for (const it of items || []) {
      const eo: any = (it as any).engagement_order;
      if (eo?.bundle_id && !bundleMap.has(`${eo.bundle_id}|${it.service_id}|${it.engagement_type}`)) {
        orphanedFromBundle++;
      }
      const runs = (it as any).runs || [];
      if (runs.length > 0) {
        const sum = runs.reduce((a: number, r: any) => a + (r.quantity_to_send || 0), 0);
        if (sum !== it.quantity) mismatchedRunSum++;
      }
    }
    results.bundle_runs_integrity = {
      pass: mismatchedRunSum === 0 && orphanedFromBundle === 0,
      items_checked: items?.length || 0,
      mismatched_run_sum_count: mismatchedRunSum,
      orphaned_from_bundle_count: orphanedFromBundle,
    };

    // ---- 2. provider_order_id uniqueness ----
    const { data: pids, error: pidsErr } = await admin
      .from("organic_run_schedule")
      .select("provider_order_id")
      .not("provider_order_id", "is", null);
    if (pidsErr) throw pidsErr;
    const seen = new Map<string, number>();
    for (const r of pids || []) {
      const k = String((r as any).provider_order_id);
      seen.set(k, (seen.get(k) || 0) + 1);
    }
    let duplicateCount = 0;
    for (const v of seen.values()) if (v > 1) duplicateCount++;
    results.provider_order_id_unique = {
      pass: duplicateCount === 0,
      total_dispatched: pids?.length || 0,
      duplicate_count: duplicateCount,
    };

    // ---- 3. repeat dispatch prevention ----
    const { data: badStarted, error: bsErr } = await admin
      .from("organic_run_schedule")
      .select("id, error_message")
      .in("status", ["completed", "started"])
      .is("provider_order_id", null);
    if (bsErr) throw bsErr;
    const filteredBadStarted = (badStarted || []).filter((r: any) => {
      const msg = (r.error_message || "").toLowerCase();
      return !msg.includes("[dispatch uncertain]") && !msg.includes("[awaiting provider confirmation]");
    });

    const { count: badPendingCount, error: bpErr } = await admin
      .from("organic_run_schedule")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .not("provider_order_id", "is", null);
    if (bpErr) throw bpErr;

    results.repeat_dispatch_prevention = {
      pass: filteredBadStarted.length === 0 && (badPendingCount || 0) === 0,
      started_or_completed_without_provider_id_count: filteredBadStarted.length,
      pending_with_provider_id_count: badPendingCount || 0,
    };

    const allPass = Object.values(results).every((r: any) => r.pass);
    return new Response(JSON.stringify({ pass: allPass, results }, null, 2), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: String(e?.message || e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
