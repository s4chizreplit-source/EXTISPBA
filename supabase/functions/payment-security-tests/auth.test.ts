// Authenticated regression tests: confirms that even a real signed-in user
// (holding a valid Supabase JWT) still cannot activate subscriptions or
// credit wallets by any client-side path. All the same attack surfaces as
// the anon suite are re-run under an authenticated bearer token.
//
// Session bootstrap order:
//   1. TEST_USER_EMAIL + TEST_USER_PASSWORD env  → sign in
//   2. anonymous sign-in                          → try
//   3. signUp with random creds                   → succeeds only if
//                                                   auto-confirm is on
// If none yield a session, tests are marked `ignore` with a clear reason.

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
const AUTH = `${SUPABASE_URL}/auth/v1`;
const FUNCTIONS = `${SUPABASE_URL}/functions/v1`;

type Session = { access_token: string; user: { id: string; email?: string } };

async function trySignInPassword(email: string, password: string): Promise<Session | null> {
  const res = await fetch(`${AUTH}/token?grant_type=password`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.text();
  if (!res.ok) return null;
  try {
    const j = JSON.parse(body);
    if (j?.access_token && j?.user?.id) return j as Session;
  } catch { /* noop */ }
  return null;
}

async function trySignUp(email: string, password: string): Promise<Session | null> {
  const res = await fetch(`${AUTH}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.text();
  if (!res.ok) return null;
  try {
    const j = JSON.parse(body);
    if (j?.access_token && j?.user?.id) return j as Session;
  } catch { /* noop */ }
  return null;
}

async function trySignInAnonymous(): Promise<Session | null> {
  const res = await fetch(`${AUTH}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: ANON_KEY },
    body: JSON.stringify({}),
  });
  const body = await res.text();
  if (!res.ok) return null;
  try {
    const j = JSON.parse(body);
    if (j?.access_token && j?.user?.id) return j as Session;
  } catch { /* noop */ }
  return null;
}

async function bootstrapSession(): Promise<
  { session: Session | null; reason: string }
> {
  const email = Deno.env.get("TEST_USER_EMAIL");
  const password = Deno.env.get("TEST_USER_PASSWORD");
  if (email && password) {
    const s = await trySignInPassword(email, password);
    if (s) return { session: s, reason: "env credentials" };
  }
  const anon = await trySignInAnonymous();
  if (anon) return { session: anon, reason: "anonymous sign-in" };

  const rand = `regress-${crypto.randomUUID()}@example.com`;
  const pw = crypto.randomUUID();
  const signup = await trySignUp(rand, pw);
  if (signup) return { session: signup, reason: "signup w/ auto-confirm" };

  return {
    session: null,
    reason:
      "No session available. Set TEST_USER_EMAIL/TEST_USER_PASSWORD or enable anonymous sign-in.",
  };
}

const { session, reason } = await bootstrapSession();
console.log(`[auth-suite] session bootstrap: ${reason}`);

const test = session ? Deno.test : Deno.test.ignore;
const USER_ID = session?.user.id ?? "00000000-0000-0000-0000-000000000000";
const FAKE_ORDER = `auth-regress-${crypto.randomUUID()}`;
const FAKE_TRACK = `auth-track-${crypto.randomUUID()}`;

function authHeaders(): HeadersInit {
  return {
    "Content-Type": "application/json",
    apikey: ANON_KEY,
    Authorization: `Bearer ${session!.access_token}`,
    Prefer: "return=representation",
  };
}

async function callRpc(name: string, payload: Record<string, unknown>) {
  const res = await fetch(`${REST}/rpc/${name}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.text() };
}

async function insertRow(table: string, row: Record<string, unknown>) {
  const res = await fetch(`${REST}/${table}`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(row),
  });
  return { status: res.status, body: await res.text() };
}

async function selectRow(table: string, query: string) {
  const res = await fetch(`${REST}/${table}?${query}`, {
    method: "GET",
    headers: authHeaders(),
  });
  return { status: res.status, body: await res.text() };
}

async function postWebhook(path: string, body: unknown, ct = "application/json") {
  const res = await fetch(`${FUNCTIONS}/${path}`, {
    method: "POST",
    headers: {
      "Content-Type": ct,
      apikey: ANON_KEY,
      Authorization: `Bearer ${session!.access_token}`,
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

// ─── G. Authenticated RPC bypass attempts ──────────────────────────────────

test("G1 — auth user cannot call activate_subscription_oxapay", async () => {
  const { status, body } = await callRpc("activate_subscription_oxapay", {
    p_user_id: USER_ID,
    p_order_id: FAKE_ORDER,
    p_plan: "lifetime",
    p_amount_usd: 299,
    p_track_id: FAKE_TRACK,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

test("G2 — auth user cannot call credit_wallet_oxapay", async () => {
  const { status, body } = await callRpc("credit_wallet_oxapay", {
    p_user_id: USER_ID,
    p_order_id: FAKE_ORDER,
    p_amount_usd: 500,
    p_track_id: FAKE_TRACK,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

test("G3 — auth user cannot call credit_wallet_razorpay", async () => {
  const { status, body } = await callRpc("credit_wallet_razorpay", {
    p_user_id: USER_ID,
    p_payment_id: `pay_auth_${crypto.randomUUID()}`,
    p_amount_usd: 100,
    p_amount_inr: 8350,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

test("G4 — auth user cannot call credit_wallet_zapupi", async () => {
  const { status, body } = await callRpc("credit_wallet_zapupi", {
    p_user_id: USER_ID,
    p_order_id: FAKE_ORDER,
    p_amount_usd: 100,
    p_amount_inr: 8350,
    p_txn_id: "auth-txn",
    p_utr: "auth-utr",
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

// ─── H. Authenticated direct table INSERTs (self-targeted) ─────────────────

test("H1 — auth user cannot insert oxapay_deposits for themselves", async () => {
  const { status, body } = await insertRow("oxapay_deposits", {
    user_id: USER_ID,
    order_id: FAKE_ORDER,
    amount_usd: 299,
    status: "paid",
    credited: false,
    plan_type: "lifetime",
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

test("H2 — auth user cannot insert zapupi_deposits for themselves", async () => {
  const { status, body } = await insertRow("zapupi_deposits", {
    user_id: USER_ID,
    order_id: FAKE_ORDER,
    amount_inr: 8350,
    amount_usd: 100,
    status: "success",
    credited: false,
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

test("H3 — auth user cannot self-activate a subscription", async () => {
  const { status, body } = await insertRow("subscriptions", {
    user_id: USER_ID,
    plan_type: "lifetime",
    status: "active",
    expires_at: new Date(Date.now() + 3.15e10).toISOString(),
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

test("H4 — auth user cannot insert a fake wallet-credit transaction", async () => {
  const { status, body } = await insertRow("transactions", {
    user_id: USER_ID,
    type: "deposit",
    amount: 1000,
    balance_after: 1000,
    status: "completed",
    payment_method: "attacker",
    description: "fake credit by auth user",
  });
  assert(isDenied(status, body), `expected denial. status=${status} body=${body}`);
});

test("H5 — auth user cannot update their own wallet balance directly", async () => {
  const res = await fetch(
    `${REST}/wallets?user_id=eq.${USER_ID}`,
    { method: "PATCH", headers: authHeaders(), body: JSON.stringify({ balance: 999999 }) },
  );
  const body = await res.text();
  if (res.status === 200) {
    // Postgres returned rows only if the update actually touched something.
    // Confirm the balance did not change to the attacker value.
    const post = await selectRow("wallets", `user_id=eq.${USER_ID}&select=balance`);
    if (post.status === 200) {
      try {
        const arr = JSON.parse(post.body);
        if (Array.isArray(arr) && arr.length) {
          assert(
            Number(arr[0].balance) !== 999999,
            `wallet balance was tampered: ${post.body}`,
          );
        }
      } catch { /* no rows visible via RLS = fine */ }
    }
  } else {
    assert(isDenied(res.status, body), `unexpected. status=${res.status} body=${body}`);
  }
});

// ─── I. Authenticated forged webhook / self-targeted replay ────────────────

test("I1 — auth user forging OxaPay webhook cannot activate their own sub", async () => {
  const forged = `auth-forged-oxa-${crypto.randomUUID()}`;
  const { json } = await postWebhook("oxapay-webhook", {
    order_id: forged,
    track_id: `auth-forged-${crypto.randomUUID()}`,
    status: "paid",
    paid_amount: 299,
    email: session!.user.email || "auth-attacker@example.com",
  });
  const activated =
    json?.result && (json.result.activated === true || json.result.credited === true);
  assert(!activated, `forged webhook activated for auth user: ${JSON.stringify(json)}`);

  const sub = await selectRow(
    "subscriptions",
    `user_id=eq.${USER_ID}&status=eq.active&select=id`,
  );
  if (sub.status === 200) {
    assertEquals(sub.body.trim(), "[]", `auth user gained active sub: ${sub.body}`);
  }
});

test("I2 — auth user forging ZapUPI webhook cannot credit their own wallet", async () => {
  const forged = `auth-forged-zap-${crypto.randomUUID()}`;
  const { json } = await postWebhook(
    "zapupi-webhook",
    new URLSearchParams({
      order_id: forged,
      status: "success",
      amount: "100",
      udf1: USER_ID,
      txn_id: `auth-${crypto.randomUUID()}`,
    }).toString(),
    "application/x-www-form-urlencoded",
  );
  assert(json?.credited !== true, `forged webhook credited auth user: ${JSON.stringify(json)}`);

  const tx = await selectRow(
    "transactions",
    `payment_reference=eq.${forged}&select=id`,
  );
  if (tx.status === 200) {
    assertEquals(tx.body.trim(), "[]", `forged order produced a transaction: ${tx.body}`);
  }
});

// ─── J. End-state audit (authenticated view) ───────────────────────────────

test("J1 — no active subscription exists for the auth user after all attacks", async () => {
  const { status, body } = await selectRow(
    "subscriptions",
    `user_id=eq.${USER_ID}&status=eq.active&select=id,plan_type`,
  );
  if (status === 200) {
    assertEquals(body.trim(), "[]", `auth user has an active subscription: ${body}`);
  } else {
    assert(isDenied(status, body), `unexpected. ${status} ${body}`);
  }
});

test("J2 — no fake deposit transaction exists for auth user's attacks", async () => {
  const { status, body } = await selectRow(
    "transactions",
    `user_id=eq.${USER_ID}&payment_reference=eq.${FAKE_ORDER}&select=id`,
  );
  if (status === 200) {
    assertEquals(body.trim(), "[]", `auth user has a fake transaction: ${body}`);
  } else {
    assert(isDenied(status, body), `unexpected. ${status} ${body}`);
  }
});
