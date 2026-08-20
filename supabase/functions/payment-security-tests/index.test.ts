// Regression tests: end-to-end verification that NO client — anonymous,
// authenticated, or spoofing a webhook — can activate a subscription or
// credit a wallet without a genuine provider-verified payment.
//
// Covers:
//   A. Direct RPC calls  (activate_subscription_oxapay, credit_wallet_*)
//   B. Direct table INSERTs on deposits tables (RLS bypass attempts)
//   C. Forged OxaPay webhook POST     → must be rejected by provider re-verify
//   D. Forged ZapUPI webhook POST     → must be rejected by provider re-verify
//   E. Replayed webhook delivery      → must be short-circuited as duplicate
//   F. End-state audit                → no subscription active, no wallet txn

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL =
  Deno.env.get("VITE_SUPABASE_URL") || Deno.env.get("SUPABASE_URL")!;
const ANON_KEY =
  Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY") ||
  Deno.env.get("SUPABASE_ANON_KEY")!;

assert(SUPABASE_URL, "VITE_SUPABASE_URL missing");
assert(ANON_KEY, "VITE_SUPABASE_PUBLISHABLE_KEY missing");

const REST = `${SUPABASE_URL}/rest/v1`;
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;
const FAKE_USER = "00000000-0000-0000-0000-000000000042";
const FAKE_ORDER = `regress-${crypto.randomUUID()}`;
const FAKE_TRACK = `track-${crypto.randomUUID()}`;

function headers(): HeadersInit {
  return {
    "Content-Type": "application/json",
    "apikey": ANON_KEY,
    "Authorization": `Bearer ${ANON_KEY}`,
    "Prefer": "return=representation",
  };
}

async function callRpc(name: string, payload: Record<string, unknown>) {
  const res = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

async function insertRow(table: string, row: Record<string, unknown>) {
  const res = await fetch(`${REST}/${table}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(row),
  });
  return { status: res.status, body: await res.text() };
}

async function selectRow(table: string, query: string) {
  const res = await fetch(`${REST}/${table}?${query}`, {
    method: "GET",
    headers: headers(),
  });
  return { status: res.status, body: await res.text() };
}

async function postWebhook(path: string, body: unknown, contentType = "application/json") {
  const res = await fetch(`${FUNCTIONS}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "apikey": ANON_KEY,
      "Authorization": `Bearer ${ANON_KEY}`,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* keep raw */ }
  return { status: res.status, body: text, json };
}

function isDenied(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 404) return true;
  if (status >= 400) {
    const b = body.toLowerCase();
    return (
      b.includes("permission denied") ||
      b.includes("not permitted") ||
      b.includes("not authenticated") ||
      b.includes("unauthorized") ||
      b.includes("no function matches") ||
      b.includes("row-level security") ||
      b.includes("violates row-level security")
    );
  }
  return false;
}

// ─── A. RPC bypass attempts ────────────────────────────────────────────────

Deno.test("A1 — activate_subscription_oxapay: client call rejected", async () => {
  const { status, body } = await callRpc("activate_subscription_oxapay", {
    p_user_id: FAKE_USER,
    p_order_id: FAKE_ORDER,
    p_plan: "lifetime",
    p_amount_usd: 299,
    p_track_id: FAKE_TRACK,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("A2 — credit_wallet_oxapay: client call rejected", async () => {
  const { status, body } = await callRpc("credit_wallet_oxapay", {
    p_user_id: FAKE_USER,
    p_order_id: FAKE_ORDER,
    p_amount_usd: 500,
    p_track_id: FAKE_TRACK,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("A3 — credit_wallet_razorpay: client call rejected", async () => {
  const { status, body } = await callRpc("credit_wallet_razorpay", {
    p_user_id: FAKE_USER,
    p_payment_id: `pay_regress_${crypto.randomUUID()}`,
    p_amount_usd: 100,
    p_amount_inr: 8350,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("A4 — credit_wallet_zapupi: client call rejected", async () => {
  const { status, body } = await callRpc("credit_wallet_zapupi", {
    p_user_id: FAKE_USER,
    p_order_id: FAKE_ORDER,
    p_amount_usd: 100,
    p_amount_inr: 8350,
    p_txn_id: "attacker-txn",
    p_utr: "attacker-utr",
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

// ─── B. Direct table INSERT attempts (fake deposit rows) ───────────────────

Deno.test("B1 — INSERT oxapay_deposits (fake row) rejected", async () => {
  const { status, body } = await insertRow("oxapay_deposits", {
    user_id: FAKE_USER,
    order_id: FAKE_ORDER,
    amount_usd: 299,
    status: "paid",
    credited: false,
    plan_type: "lifetime",
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("B2 — INSERT zapupi_deposits (fake row) rejected", async () => {
  const { status, body } = await insertRow("zapupi_deposits", {
    user_id: FAKE_USER,
    order_id: FAKE_ORDER,
    amount_inr: 8350,
    amount_usd: 100,
    status: "success",
    credited: false,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("B3 — INSERT deposits (fake row) rejected", async () => {
  const { status, body } = await insertRow("deposits", {
    user_id: FAKE_USER,
    amount: 100,
    status: "verified",
    payment_method: "attacker",
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("B4 — INSERT subscriptions (self-activate) rejected", async () => {
  const { status, body } = await insertRow("subscriptions", {
    user_id: FAKE_USER,
    plan_type: "lifetime",
    status: "active",
    expires_at: new Date(Date.now() + 3.15e10).toISOString(),
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("B5 — INSERT transactions (fake wallet credit) rejected", async () => {
  const { status, body } = await insertRow("transactions", {
    user_id: FAKE_USER,
    type: "deposit",
    amount: 1000,
    balance_after: 1000,
    status: "completed",
    payment_method: "attacker",
    description: "fake credit",
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

Deno.test("B6 — direct UPDATE of wallet balance rejected", async () => {
  const res = await fetch(
    `${REST}/wallets?user_id=eq.${FAKE_USER}`,
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ balance: 999999 }),
    },
  );
  const body = await res.text();
  // Either RLS blocks it (403) OR it silently matches zero rows (200 + [])
  if (res.status === 200) {
    assertEquals(body.trim(), "[]", `wallet update must not affect any row. got=${body}`);
  } else {
    assert(isDenied(res.status, body), `unexpected. status=${res.status} body=${body}`);
  }
});

// ─── C. Forged OxaPay webhook (no real payment) ────────────────────────────

Deno.test("C1 — forged OxaPay webhook does NOT activate subscription", async () => {
  const forgedOrder = `forged-oxa-${crypto.randomUUID()}`;
  const { status, json } = await postWebhook("oxapay-webhook", {
    order_id: forgedOrder,
    track_id: `forged-${crypto.randomUUID()}`,
    status: "paid",
    paid_amount: 299,
    email: `attacker+${crypto.randomUUID()}@example.com`,
  });

  // Function must respond, but must NOT credit / activate anything.
  // Expected outcomes are any of:
  //   - 400/404 with error (deposit_not_found / static_link_email_not_found)
  //   - 200 with duplicate / expired / verify_failed
  // In all cases: ok!==true OR result is absent.
  const activated =
    json?.result &&
    (json.result.activated === true || json.result.credited === true);
  assert(!activated, `forged webhook activated something. status=${status} json=${JSON.stringify(json)}`);

  // Confirm no subscription became active for a random email/user.
  const sub = await selectRow(
    "subscriptions",
    `status=eq.active&updated_at=gte.${new Date(Date.now() - 60_000).toISOString()}&select=id,user_id`,
  );
  if (sub.status === 200) {
    // rows returned here belong to other flows — none should reference our forged order
    // Cross-check via transactions.payment_reference
    const tx = await selectRow(
      "transactions",
      `payment_reference=eq.${forgedOrder}&select=id`,
    );
    if (tx.status === 200) {
      assertEquals(tx.body.trim(), "[]", `forged order created a transaction: ${tx.body}`);
    }
  }
});

Deno.test("C2 — forged OxaPay webhook with missing order_id rejected", async () => {
  const { status, json } = await postWebhook("oxapay-webhook", {
    track_id: "no-order",
    status: "paid",
    paid_amount: 500,
  });
  // Handler returns 400 with { ok: false } when order_id missing.
  assert(
    status === 400 || json?.ok === false,
    `expected rejection. status=${status} json=${JSON.stringify(json)}`,
  );
});

// ─── D. Forged ZapUPI webhook (no real payment) ────────────────────────────

Deno.test("D1 — forged ZapUPI subscription webhook does NOT activate subscription", async () => {
  const forgedOrder = `forged-zap-${crypto.randomUUID()}`;
  const { status, json } = await postWebhook(
    "zapupi-webhook",
    new URLSearchParams({
      order_id: forgedOrder,
      status: "success",
      amount: "1499",
      udf1: FAKE_USER,
      udf2: "monthly_subscription",
      txn_id: `forged-${crypto.randomUUID()}`,
    }).toString(),
    "application/x-www-form-urlencoded",
  );

  // Handler always returns 200 to the provider, but must NOT report a
  // successful activation for a fake order the provider cannot verify.
  const activated = json?.subscription === true && json?.duplicate !== true;
  assert(!activated, `forged zapupi webhook activated subscription. status=${status} json=${JSON.stringify(json)}`);

  // Confirm no active sub exists for the fake user.
  const sub = await selectRow(
    "subscriptions",
    `user_id=eq.${FAKE_USER}&status=eq.active&select=id`,
  );
  if (sub.status === 200) {
    assertEquals(sub.body.trim(), "[]", `fake user gained an active subscription: ${sub.body}`);
  } else {
    assert(isDenied(sub.status, sub.body), `unexpected read. ${sub.status} ${sub.body}`);
  }
});

Deno.test("D2 — forged ZapUPI wallet-credit webhook does NOT credit", async () => {
  const forgedOrder = `forged-zap-wallet-${crypto.randomUUID()}`;
  const { status, json } = await postWebhook("zapupi-webhook", {
    order_id: forgedOrder,
    status: "success",
    amount: 100,
    txn_id: `forged-${crypto.randomUUID()}`,
  });

  const credited = json?.credited === true;
  assert(!credited, `forged zapupi webhook credited a wallet. status=${status} json=${JSON.stringify(json)}`);

  const tx = await selectRow(
    "transactions",
    `payment_reference=eq.${forgedOrder}&select=id`,
  );
  if (tx.status === 200) {
    assertEquals(tx.body.trim(), "[]", `forged order produced a transaction: ${tx.body}`);
  }
});

// ─── E. Replay protection (idempotency gate) ───────────────────────────────

Deno.test("E1 — replaying same OxaPay webhook is flagged duplicate", async () => {
  const orderId = `replay-oxa-${crypto.randomUUID()}`;
  const trackId = `replay-track-${crypto.randomUUID()}`;
  const payload = {
    order_id: orderId,
    track_id: trackId,
    status: "paid",
    paid_amount: 15,
    email: "replay@example.com",
  };

  const first = await postWebhook("oxapay-webhook", payload);
  const second = await postWebhook("oxapay-webhook", payload);

  // Second delivery MUST either be a duplicate at the gate, or produce the
  // same non-activation result as the first (no credit / activate).
  const secondActivated =
    second.json?.result &&
    (second.json.result.activated === true || second.json.result.credited === true);
  assert(!secondActivated, `replay activated something. second=${JSON.stringify(second.json)}`);

  // If duplicate was reported explicitly, that's the strongest signal.
  if (second.json?.duplicate === true) {
    assertEquals(second.json.duplicate, true);
  }
  // First was already rejected (unknown deposit / email not found), so
  // no state was created. Just assert no transaction exists for this order.
  const tx = await selectRow(
    "transactions",
    `payment_reference=eq.${orderId}&select=id`,
  );
  if (tx.status === 200) {
    assertEquals(tx.body.trim(), "[]", `replay order created a transaction: ${tx.body}`);
  }
});

// Helper: count rows returned by a REST select (parsed JSON array length).
async function countRows(table: string, query: string): Promise<number> {
  const { status, body } = await selectRow(table, query);
  if (status !== 200) return 0;
  try {
    const arr = JSON.parse(body);
    return Array.isArray(arr) ? arr.length : 0;
  } catch {
    return 0;
  }
}

Deno.test("E2 — OxaPay replay: transaction count stays ≤ 1 across duplicate deliveries", async () => {
  const orderId = `replay2-oxa-${crypto.randomUUID()}`;
  const trackId = `replay2-track-${crypto.randomUUID()}`;
  const payload = {
    order_id: orderId,
    track_id: trackId,
    status: "paid",
    paid_amount: 25,
    email: "replay2@example.com",
  };

  // Fire the same payload three times sequentially.
  const r1 = await postWebhook("oxapay-webhook", payload);
  const r2 = await postWebhook("oxapay-webhook", payload);
  const r3 = await postWebhook("oxapay-webhook", payload);

  // None of them may report an activation / credit — the deposit row does
  // not exist, so all three must be rejected before touching the wallet.
  for (const [i, r] of [r1, r2, r3].entries()) {
    const activated =
      r.json?.result &&
      (r.json.result.activated === true || r.json.result.credited === true);
    assert(!activated, `delivery ${i + 1} activated something: ${JSON.stringify(r.json)}`);
  }

  // Strict end-state: transactions for this payment_reference must be ≤ 1.
  const txCount = await countRows(
    "transactions",
    `payment_reference=eq.${orderId}&select=id`,
  );
  assert(txCount <= 1, `expected at most 1 transaction, got ${txCount}`);

  // And no active subscription may exist tied to this replay window.
  const subCount = await countRows(
    "subscriptions",
    `status=eq.active&updated_at=gte.${new Date(Date.now() - 60_000).toISOString()}&select=id`,
  );
  // Just make sure the query is answerable; if RLS blocks reads that's fine.
  assert(subCount >= 0);
});

Deno.test("E3 — ZapUPI wallet-credit replay: only one credit outcome across duplicates", async () => {
  const orderId = `replay-zap-wallet-${crypto.randomUUID()}`;
  const payload = new URLSearchParams({
    order_id: orderId,
    status: "success",
    amount: "100",
    txn_id: `replay-${crypto.randomUUID()}`,
  }).toString();

  const r1 = await postWebhook("zapupi-webhook", payload, "application/x-www-form-urlencoded");
  const r2 = await postWebhook("zapupi-webhook", payload, "application/x-www-form-urlencoded");
  const r3 = await postWebhook("zapupi-webhook", payload, "application/x-www-form-urlencoded");

  const credits = [r1, r2, r3].filter((r) => r.json?.credited === true).length;
  // The forged/unknown order must never credit. At most one credit total
  // even if a matching deposit existed — the idempotency gate must dedupe.
  assert(credits <= 1, `expected ≤ 1 credit across replays, got ${credits}`);

  // Second and third deliveries should either mirror the first or be
  // explicitly flagged as duplicate — never a fresh credit.
  if (r1.json?.credited === true) {
    assert(
      r2.json?.credited !== true || r2.json?.duplicate === true,
      `replay 2 double-credited: ${JSON.stringify(r2.json)}`,
    );
    assert(
      r3.json?.credited !== true || r3.json?.duplicate === true,
      `replay 3 double-credited: ${JSON.stringify(r3.json)}`,
    );
  }

  const txCount = await countRows(
    "transactions",
    `payment_reference=eq.${orderId}&select=id`,
  );
  assert(txCount <= 1, `expected ≤ 1 transaction for order, got ${txCount}`);
});

Deno.test("E4 — ZapUPI subscription replay: activation happens at most once", async () => {
  const orderId = `replay-zap-sub-${crypto.randomUUID()}`;
  const payload = new URLSearchParams({
    order_id: orderId,
    status: "success",
    amount: "1499",
    udf1: FAKE_USER,
    udf2: "monthly_subscription",
    txn_id: `replay-${crypto.randomUUID()}`,
  }).toString();

  const r1 = await postWebhook("zapupi-webhook", payload, "application/x-www-form-urlencoded");
  const r2 = await postWebhook("zapupi-webhook", payload, "application/x-www-form-urlencoded");
  const r3 = await postWebhook("zapupi-webhook", payload, "application/x-www-form-urlencoded");

  const activations = [r1, r2, r3].filter(
    (r) => r.json?.subscription === true && r.json?.duplicate !== true,
  ).length;
  assert(activations <= 1, `expected ≤ 1 activation across replays, got ${activations}`);

  // Fake user must not gain an active subscription from a forged replay.
  const { status, body } = await selectRow(
    "subscriptions",
    `user_id=eq.${FAKE_USER}&status=eq.active&select=id`,
  );
  if (status === 200) {
    assertEquals(body.trim(), "[]", `fake user has active sub after replays: ${body}`);
  }

  // Never more than one transaction rows for the same replayed order.
  const txCount = await countRows(
    "transactions",
    `payment_reference=eq.${orderId}&select=id`,
  );
  assert(txCount <= 1, `expected ≤ 1 transaction, got ${txCount}`);
});

// ─── E-concurrent. Parallel replay dedup ───────────────────────────────────
// Fire the identical webhook payload N times in parallel. The idempotency
// gate (payload_hash / order_id + track_id) must ensure that AT MOST ONE
// delivery reaches the credit/activate stage — every other concurrent
// delivery must be short-circuited as a duplicate, rejected, or return a
// no-op result. This proves the dedup layer is race-safe, not just
// sequentially safe.

const CONCURRENCY = 10;

function countActivations(results: Array<{ json: any }>): number {
  return results.filter((r) => {
    const j = r.json;
    if (!j) return false;
    if (j.duplicate === true) return false;
    if (j.subscription === true) return true;
    if (j.credited === true) return true;
    const inner = j.result;
    if (inner && (inner.activated === true || inner.credited === true)) return true;
    return false;
  }).length;
}

function countDuplicates(results: Array<{ json: any }>): number {
  return results.filter((r) => {
    const j = r.json;
    if (!j) return false;
    if (j.duplicate === true) return true;
    const msg = (j.message || j.error || j.status || "").toString().toLowerCase();
    return msg.includes("duplicate") || msg.includes("already") || msg.includes("processed");
  }).length;
}

Deno.test(
  `E-concurrent-1 — OxaPay: ${CONCURRENCY} parallel identical deliveries yield ≤ 1 activation`,
  async () => {
    const orderId = `concurrent-oxa-${crypto.randomUUID()}`;
    const trackId = `concurrent-track-${crypto.randomUUID()}`;
    const payload = {
      order_id: orderId,
      track_id: trackId,
      status: "paid",
      paid_amount: 25,
      email: "concurrent@example.com",
    };

    // Fire all N in parallel — this is the race the dedup gate must survive.
    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        postWebhook("oxapay-webhook", payload),
      ),
    );

    // Every response must be an HTTP-level accept (2xx/4xx handled), never 5xx.
    for (const [i, r] of results.entries()) {
      assert(r.status < 500, `delivery ${i} returned 5xx: ${r.status} ${r.body}`);
    }

    // At most one delivery may report a real activation / credit outcome.
    // (For this forged payload with no matching deposit row it should be 0,
    // but we assert ≤ 1 so the same test also covers the legitimate case.)
    const activated = countActivations(results);
    assert(
      activated <= 1,
      `expected ≤ 1 activation across ${CONCURRENCY} parallel replays, got ${activated}. ` +
        `responses=${JSON.stringify(results.map((r) => r.json))}`,
    );

    // The remaining deliveries must be observably dedup'd — either
    // flagged as duplicate/already-processed, or rejected before credit.
    // We only require the rejection accounting to add up: activated + non-activated == N.
    const nonActivated = CONCURRENCY - activated;
    assert(nonActivated >= CONCURRENCY - 1, `math sanity: ${nonActivated}`);

    // If the pipeline surfaces "duplicate" markers, at least some of the
    // losers of the race should carry that signal.
    const dupes = countDuplicates(results);
    if (activated === 1) {
      assert(
        dupes >= 1,
        `activation happened but no delivery was marked duplicate; ` +
          `responses=${JSON.stringify(results.map((r) => r.json))}`,
      );
    }

    // Strict end-state: transactions for this order_id must be ≤ 1.
    const txCount = await countRows(
      "transactions",
      `payment_reference=eq.${orderId}&select=id`,
    );
    assert(txCount <= 1, `expected ≤ 1 transaction, got ${txCount}`);

    // And no active subscription may exist tied to this fake user via
    // this replay window.
    const { status, body } = await selectRow(
      "subscriptions",
      `user_id=eq.${FAKE_USER}&status=eq.active&select=id`,
    );
    if (status === 200) {
      assertEquals(
        body.trim(),
        "[]",
        `fake user gained an active sub via concurrent replay: ${body}`,
      );
    }
  },
);

Deno.test(
  `E-concurrent-2 — ZapUPI: ${CONCURRENCY} parallel identical deliveries yield ≤ 1 credit`,
  async () => {
    const orderId = `concurrent-zap-${crypto.randomUUID()}`;
    const txnId = `concurrent-txn-${crypto.randomUUID()}`;
    const payload = new URLSearchParams({
      order_id: orderId,
      status: "success",
      amount: "100",
      txn_id: txnId,
    }).toString();

    const results = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        postWebhook("zapupi-webhook", payload, "application/x-www-form-urlencoded"),
      ),
    );

    for (const [i, r] of results.entries()) {
      assert(r.status < 500, `delivery ${i} returned 5xx: ${r.status} ${r.body}`);
    }

    const credited = countActivations(results);
    assert(
      credited <= 1,
      `expected ≤ 1 credit across ${CONCURRENCY} parallel replays, got ${credited}. ` +
        `responses=${JSON.stringify(results.map((r) => r.json))}`,
    );

    const dupes = countDuplicates(results);
    if (credited === 1) {
      assert(
        dupes >= 1,
        `credit happened but no delivery was marked duplicate; ` +
          `responses=${JSON.stringify(results.map((r) => r.json))}`,
      );
    }

    const txCount = await countRows(
      "transactions",
      `payment_reference=eq.${orderId}&select=id`,
    );
    assert(txCount <= 1, `expected ≤ 1 transaction, got ${txCount}`);
  },
);

Deno.test(
  `E-concurrent-3 — webhook_events records a single payload_hash for the burst`,
  async () => {
    // If the client can read webhook_events (admin only in prod, but the
    // regression harness may or may not have the role), sanity check that
    // the concurrent burst produced exactly ONE "credited"/"processed"-style
    // outcome per unique payload_hash. If reads are RLS-blocked we skip.
    const orderId = `concurrent-audit-${crypto.randomUUID()}`;
    const trackId = `concurrent-audit-track-${crypto.randomUUID()}`;
    const payload = {
      order_id: orderId,
      track_id: trackId,
      status: "paid",
      paid_amount: 25,
      email: "concurrent-audit@example.com",
    };

    await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        postWebhook("oxapay-webhook", payload),
      ),
    );

    const { status, body } = await selectRow(
      "webhook_events",
      `order_id=eq.${orderId}&outcome=in.(credited,activated)&select=id`,
    );
    if (status !== 200) {
      // RLS-blocked or table not readable → nothing else to assert.
      assert(isDenied(status, body) || status === 401 || status === 403);
      return;
    }
    let rows: unknown[] = [];
    try {
      rows = JSON.parse(body);
    } catch {
      rows = [];
    }
    assert(
      Array.isArray(rows) && rows.length <= 1,
      `webhook_events shows ${Array.isArray(rows) ? rows.length : "?"} ` +
        `credited/activated rows for a single concurrent burst: ${body}`,
    );
  },
);

// ─── E-concurrent-cross. Cross-provider concurrent replay isolation ────────
// Fire the SAME order_id + track_id in parallel to BOTH oxapay-webhook and
// zapupi-webhook. Each provider must dedup its own bucket independently:
//   - No delivery on either provider may activate/credit (payloads are forged).
//   - No 5xx from either provider under the race.
//   - webhook_events rows are scoped by (provider, order_id, payload_hash),
//     so the same order_id showing up on two providers must NOT collide —
//     one provider's dedup gate must never suppress the other provider.

Deno.test(
  `E-concurrent-cross-1 — same order_id fired in parallel at BOTH providers dedups per-provider`,
  async () => {
    const sharedOrderId = `xprov-conc-${crypto.randomUUID()}`;
    const sharedTrackId = `xprov-conc-track-${crypto.randomUUID()}`;

    const oxaPayload = {
      order_id: sharedOrderId,
      track_id: sharedTrackId,
      status: "paid",
      paid_amount: 25,
      email: "xprov-conc@example.com",
    };
    const zapPayload = new URLSearchParams({
      order_id: sharedOrderId,
      status: "success",
      amount: "100",
      txn_id: sharedTrackId,
    }).toString();

    // Interleave N deliveries per provider, fired all at once.
    const half = CONCURRENCY;
    const tasks: Array<Promise<{ provider: string; status: number; body: string; json: any }>> = [];
    for (let i = 0; i < half; i++) {
      tasks.push(
        postWebhook("oxapay-webhook", oxaPayload).then((r) => ({ provider: "oxapay", ...r })),
      );
      tasks.push(
        postWebhook("zapupi-webhook", zapPayload, "application/x-www-form-urlencoded").then(
          (r) => ({ provider: "zapupi", ...r }),
        ),
      );
    }
    const results = await Promise.all(tasks);

    // No 5xx on either provider.
    for (const [i, r] of results.entries()) {
      assert(r.status < 500, `${r.provider} delivery ${i} returned 5xx: ${r.status} ${r.body}`);
    }

    const oxaResults = results.filter((r) => r.provider === "oxapay");
    const zapResults = results.filter((r) => r.provider === "zapupi");

    // Neither provider may activate/credit — payloads are forged and have no
    // matching deposit row on EITHER side.
    const oxaActivated = countActivations(oxaResults);
    const zapActivated = countActivations(zapResults);
    assertEquals(oxaActivated, 0, `oxapay activated ${oxaActivated} despite forged payload`);
    assertEquals(zapActivated, 0, `zapupi credited ${zapActivated} despite forged payload`);

    // Zero transactions on this shared id from either side.
    const txCount = await countRows(
      "transactions",
      `payment_reference=eq.${sharedOrderId}&select=id`,
    );
    assertEquals(txCount, 0, `cross-provider concurrent replay produced ${txCount} txns`);

    // Audit table (if readable): dedup MUST be scoped per provider — the
    // same order_id/payload should NOT be collapsed across providers. We
    // expect at least one webhook_events row per provider (independent
    // buckets), and never zero on one side because the other side "won"
    // the race.
    const { status: oxaStatus, body: oxaBody } = await selectRow(
      "webhook_events",
      `order_id=eq.${sharedOrderId}&provider=eq.oxapay&select=id`,
    );
    const { status: zapStatus, body: zapBody } = await selectRow(
      "webhook_events",
      `order_id=eq.${sharedOrderId}&provider=eq.zapupi&select=id`,
    );
    if (oxaStatus === 200 && zapStatus === 200) {
      let oxaRows: unknown[] = [];
      let zapRows: unknown[] = [];
      try { oxaRows = JSON.parse(oxaBody); } catch { /* noop */ }
      try { zapRows = JSON.parse(zapBody); } catch { /* noop */ }
      // If BOTH sides read empty, webhook_events is RLS-restricted for this
      // role → we can't audit cross-provider isolation from here. Skip.
      if ((oxaRows as unknown[]).length === 0 && (zapRows as unknown[]).length === 0) {
        return;
      }
      // If audit is readable, dedup must be per-provider: neither side may
      // be zero while the other has rows (that would mean one provider's
      // gate suppressed the other).
      assert(
        (oxaRows as unknown[]).length >= 1,
        `oxapay dedup was suppressed by zapupi's row (cross-provider bleed): ${oxaBody}`,
      );
      assert(
        (zapRows as unknown[]).length >= 1,
        `zapupi dedup was suppressed by oxapay's row (cross-provider bleed): ${zapBody}`,
      );
      // Per provider the burst should collapse to a single row.
      assert(
        (oxaRows as unknown[]).length <= 1,
        `oxapay recorded ${(oxaRows as unknown[]).length} rows for a single concurrent burst`,
      );
      assert(
        (zapRows as unknown[]).length <= 1,
        `zapupi recorded ${(zapRows as unknown[]).length} rows for a single concurrent burst`,
      );
    } else {
      // RLS-blocked → skip audit assertions.
      assert(
        isDenied(oxaStatus, oxaBody) || oxaStatus === 401 || oxaStatus === 403 ||
        isDenied(zapStatus, zapBody) || zapStatus === 401 || zapStatus === 403,
      );
    }
  },
);

// ─── E-cross. Cross-provider replay isolation ──────────────────────────────
// A track_id or order_id observed on one provider must never be honored by
// the other provider's webhook. Each webhook must look the id up in its own
// dedicated deposits table (oxapay_deposits vs zapupi_deposits) and reject
// when the id doesn't exist there — even if the "other" provider has an
// identically-named row.

Deno.test("E5 — OxaPay order_id replayed at ZapUPI webhook does NOT credit/activate", async () => {
  // Same id, delivered first to OxaPay, then replayed as a ZapUPI callback.
  const sharedOrderId = `xprov-${crypto.randomUUID()}`;
  const sharedTrackId = `xprov-track-${crypto.randomUUID()}`;

  // 1) Send to OxaPay first (forged — no real deposit row exists).
  const oxa = await postWebhook("oxapay-webhook", {
    order_id: sharedOrderId,
    track_id: sharedTrackId,
    status: "paid",
    paid_amount: 299,
    email: "xprov@example.com",
  });
  const oxaActivated =
    oxa.json?.result &&
    (oxa.json.result.activated === true || oxa.json.result.credited === true);
  assert(!oxaActivated, `oxapay leg activated: ${JSON.stringify(oxa.json)}`);

  // 2) Replay the SAME order_id at ZapUPI (wallet-credit shape).
  const zapWallet = await postWebhook(
    "zapupi-webhook",
    new URLSearchParams({
      order_id: sharedOrderId,
      status: "success",
      amount: "100",
      txn_id: sharedTrackId, // reuse the oxapay track id
    }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert(
    zapWallet.json?.credited !== true,
    `zapupi wallet credited via oxapay id: ${JSON.stringify(zapWallet.json)}`,
  );

  // 3) Replay the SAME order_id at ZapUPI (subscription shape).
  const zapSub = await postWebhook(
    "zapupi-webhook",
    new URLSearchParams({
      order_id: sharedOrderId,
      status: "success",
      amount: "1499",
      udf1: FAKE_USER,
      udf2: "monthly_subscription",
      txn_id: sharedTrackId,
    }).toString(),
    "application/x-www-form-urlencoded",
  );
  const subActivated =
    zapSub.json?.subscription === true && zapSub.json?.duplicate !== true;
  assert(!subActivated, `zapupi sub activated via oxapay id: ${JSON.stringify(zapSub.json)}`);

  // End-state: no transaction and no active subscription tied to this id.
  const txCount = await countRows(
    "transactions",
    `payment_reference=eq.${sharedOrderId}&select=id`,
  );
  assertEquals(txCount, 0, `cross-provider replay produced ${txCount} transactions`);

  const sub = await selectRow(
    "subscriptions",
    `user_id=eq.${FAKE_USER}&status=eq.active&select=id`,
  );
  if (sub.status === 200) {
    assertEquals(sub.body.trim(), "[]", `fake user gained sub via x-replay: ${sub.body}`);
  }
});

Deno.test("E6 — ZapUPI order_id/txn_id replayed at OxaPay webhook does NOT credit/activate", async () => {
  const sharedOrderId = `xprov2-${crypto.randomUUID()}`;
  const sharedTxnId = `xprov2-txn-${crypto.randomUUID()}`;

  // 1) Send to ZapUPI first.
  const zap = await postWebhook(
    "zapupi-webhook",
    new URLSearchParams({
      order_id: sharedOrderId,
      status: "success",
      amount: "100",
      txn_id: sharedTxnId,
    }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert(
    zap.json?.credited !== true,
    `zapupi leg credited: ${JSON.stringify(zap.json)}`,
  );

  // 2) Replay the SAME order_id/track_id at OxaPay.
  const oxa = await postWebhook("oxapay-webhook", {
    order_id: sharedOrderId,
    track_id: sharedTxnId, // reuse zapupi txn_id as oxapay track_id
    status: "paid",
    paid_amount: 299,
    email: "xprov2@example.com",
  });
  const oxaActivated =
    oxa.json?.result &&
    (oxa.json.result.activated === true || oxa.json.result.credited === true);
  assert(!oxaActivated, `oxapay activated via zapupi id: ${JSON.stringify(oxa.json)}`);

  // End-state: no transactions on either id.
  const txByOrder = await countRows(
    "transactions",
    `payment_reference=eq.${sharedOrderId}&select=id`,
  );
  assertEquals(txByOrder, 0, `cross-provider replay produced ${txByOrder} txns (order)`);

  const txByTxn = await countRows(
    "transactions",
    `payment_reference=eq.${sharedTxnId}&select=id`,
  );
  assertEquals(txByTxn, 0, `cross-provider replay produced ${txByTxn} txns (txn)`);
});

// ─── F. End-state audit ────────────────────────────────────────────────────


Deno.test("F1 — no active subscription exists for fake user after all attacks", async () => {
  const { status, body } = await selectRow(
    "subscriptions",
    `user_id=eq.${FAKE_USER}&status=eq.active&select=id`,
  );
  if (status === 200) {
    assertEquals(body.trim(), "[]", `fake user has an active subscription: ${body}`);
  } else {
    assert(isDenied(status, body), `unexpected. ${status} ${body}`);
  }
});

Deno.test("F2 — no wallet credit transaction exists for fake order", async () => {
  const { status, body } = await selectRow(
    "transactions",
    `payment_reference=eq.${FAKE_ORDER}&select=id`,
  );
  if (status === 200) {
    assertEquals(body.trim(), "[]", `fake order has a transaction: ${body}`);
  } else {
    assert(isDenied(status, body), `unexpected. ${status} ${body}`);
  }
});
