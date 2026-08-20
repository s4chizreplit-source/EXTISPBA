// Deno test: end-to-end invariants for the engagement order pipeline.
import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL") || Deno.env.get("SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY")!;

async function callInvariants() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/e2e-invariants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${ANON_KEY}`,
    },
  });
  const body = await res.json();
  return { status: res.status, body };
}

let cached: { status: number; body: any } | null = null;
async function getReport() {
  if (!cached) cached = await callInvariants();
  return cached;
}

Deno.test("e2e — bundle_items map to runs with matching quantities", async () => {
  const { status, body } = await getReport();
  assertEquals(status, 200, `function returned ${status}: ${JSON.stringify(body)}`);
  const r = body.results.bundle_runs_integrity;
  assert(
    r.pass,
    `bundle/runs integrity failed: orphaned=${r.orphaned_from_bundle_count}, mismatched_qty=${r.mismatched_run_sum_count} (items_checked=${r.items_checked})`,
  );
});

Deno.test("e2e — provider_order_id is unique across all runs", async () => {
  const { body } = await getReport();
  const r = body.results.provider_order_id_unique;
  assert(
    r.pass,
    `${r.duplicate_count} duplicate provider_order_id(s) found across ${r.total_dispatched} dispatched runs`,
  );
});

Deno.test("e2e — no repeat dispatch (pending rows never hold provider_order_id; started/completed always do)", async () => {
  const { body } = await getReport();
  const r = body.results.repeat_dispatch_prevention;
  assert(
    r.pass,
    `repeat-dispatch invariant violated: pending+provider_id=${r.pending_with_provider_id_count}, started/completed without provider_id=${r.started_or_completed_without_provider_id_count}`,
  );
});
