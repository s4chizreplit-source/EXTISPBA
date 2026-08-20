// Razorpay webhook - auto credit wallet on payment.captured
import { createClient } from "npm:@supabase/supabase-js@2";
import { escapeTelegramHtml, notifyAdminTelegram } from "../_shared/admin-telegram.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-razorpay-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const FIXED_BUTTON_AMOUNTS_PAISE = new Set([5000, 10000, 20000, 50000, 100000]);

async function resolveTrustedWalletIntent(
  supabase: ReturnType<typeof createClient>,
  paymentId: string,
  email: string,
  amountPaise: number,
) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !FIXED_BUTTON_AMOUNTS_PAISE.has(amountPaise)) return null;

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("razorpay_webhook_events")
    .select("id, payload")
    .eq("event_type", "wallet_deposit_intent")
    .is("payment_id", null)
    .eq("payload->>kind", "wallet_deposit_intent")
    .eq("payload->>status", "pending")
    .eq("payload->>provider", "razorpay")
    .eq("payload->>email", normalizedEmail)
    .eq("payload->>amount_paise", String(amountPaise))
    .gte("payload->>expires_at", nowIso)
    .order("processed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  if (!data?.id) return null;

  const intentPayload = typeof data.payload === "object" && data.payload ? data.payload as Record<string, unknown> : {};
  const userId = typeof intentPayload.user_id === "string" ? intentPayload.user_id.trim() : "";
  const intentEmail = typeof intentPayload.email === "string" ? intentPayload.email.trim().toLowerCase() : normalizedEmail;

  if (!userId || intentEmail !== normalizedEmail) return null;

  const { error: claimError } = await supabase
    .from("razorpay_webhook_events")
    .update({
      payment_id: paymentId,
      payload: {
        ...intentPayload,
        status: "processed",
        matched_payment_id: paymentId,
        matched_at: nowIso,
      },
    })
    .eq("id", data.id)
    .is("payment_id", null)
    .eq("event_type", "wallet_deposit_intent")
    .eq("payload->>status", "pending");

  if (claimError) throw claimError;

  const { data: claimedIntent, error: verifyError } = await supabase
    .from("razorpay_webhook_events")
    .select("payload")
    .eq("id", data.id)
    .eq("payment_id", paymentId)
    .maybeSingle();

  if (verifyError) throw verifyError;
  if (!claimedIntent) return null;

  return { userId, email: intentEmail };
}

async function verifySignature(body: string, signature: string, secret: string): Promise<boolean> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // constant-time compare
  if (hex.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function notifyTelegram(supabase: ReturnType<typeof createClient>, text: string) {
  void supabase;
  await notifyAdminTelegram(text);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-razorpay-signature") || "";
    const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET");

    if (!secret) {
      console.error("RAZORPAY_WEBHOOK_SECRET not set");
      return new Response(JSON.stringify({ error: "Server misconfigured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STRICT: signature header is mandatory
    if (!signature) {
      console.error("Missing x-razorpay-signature header — rejecting");
      return new Response(JSON.stringify({ error: "Missing signature" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const ok = await verifySignature(rawBody, signature, secret);
    if (!ok) {
      console.error("Invalid Razorpay signature");
      return new Response(JSON.stringify({ error: "Invalid signature" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.parse(rawBody);
    const event = payload?.event;
    console.log("Razorpay event:", event);

    // Access-key payment guard — ignore payments from the other service
    const paymentNotes = payload?.payload?.payment?.entity?.notes || {};
    const orderNotes = payload?.payload?.order?.entity?.notes || {};
    const isAccessKeyPayment =
      paymentNotes.service_code === "MUJCLONE_KEY_2026" ||
      orderNotes.service_code === "MUJCLONE_KEY_2026" ||
      paymentNotes.telegram_chat_id ||
      orderNotes.telegram_chat_id ||
      paymentNotes.chat_id ||
      orderNotes.chat_id;

    if (isAccessKeyPayment) {
      const paymentId = payload?.payload?.payment?.entity?.id || "unknown";
      console.log("Ignoring access-key payment, not for SMM panel:", paymentId);
      return new Response(
        JSON.stringify({ ok: true, ignored: "access_key_payment" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (event !== "payment.captured") {
      return new Response(JSON.stringify({ ok: true, skipped: event }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payment = payload?.payload?.payment?.entity;
    if (!payment) {
      return new Response(JSON.stringify({ error: "Missing payment entity" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const paymentId: string = payment.id;
    // Razorpay sends x-razorpay-event-id header; fall back to a deterministic id
    const eventId: string = (req.headers.get("x-razorpay-event-id") || "").trim()
      || `${event}:${paymentId}`;
    const netPaise = Number(payment.amount || 0);
    const grossPaise = netPaise + Number(payment.fee || 0) + Number(payment.tax || 0);

    // OrganicSMM Pro should only credit the exact hosted-button amounts.
    // If some other site shares the same Razorpay account/webhook, ignore it here.
    const creditPaise = FIXED_BUTTON_AMOUNTS_PAISE.has(netPaise)
      ? netPaise
      : FIXED_BUTTON_AMOUNTS_PAISE.has(grossPaise)
        ? grossPaise
        : null;

    if (creditPaise === null) {
      console.log("Ignoring Razorpay payment with unsupported amount for SMM panel:", paymentId, {
        netPaise,
        grossPaise,
      });
      return new Response(JSON.stringify({ ok: true, ignored: "unsupported_amount" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const amountInr: number = creditPaise / 100;
    if (!Number.isFinite(amountInr) || amountInr <= 0) {
      console.error("Blocked Razorpay payment with invalid captured amount", paymentId, payment.amount);
      return new Response(JSON.stringify({ error: "Invalid captured amount" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // STRICT: only credit when Razorpay confirms capture (defence-in-depth)
    if (payment.status && payment.status !== "captured") {
      console.error(`Payment ${paymentId} status=${payment.status}, not crediting`);
      return new Response(JSON.stringify({ ok: true, skipped: payment.status }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // Event-level idempotency guard. UNIQUE(event_id) ensures the same webhook
    // delivery is never processed twice, even before reaching the wallet RPC.
    const { error: eventInsertErr } = await supabase
      .from("razorpay_webhook_events")
      .insert({
        event_id: eventId,
        event_type: event,
        payment_id: paymentId,
        payload,
      });

    if (eventInsertErr) {
      const msg = String(eventInsertErr.message || "");
      // 23505 = unique_violation → already processed, ack 200
      if ((eventInsertErr as any).code === "23505" || msg.includes("duplicate key")) {
        console.log("Duplicate webhook event", eventId, "— already processed, ack 200");
        return new Response(JSON.stringify({ ok: true, duplicate_event: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      console.error("Failed to record webhook event:", msg);
      throw eventInsertErr;
    }

    const notes = payment.notes || {};
    const checkoutEmail = typeof payment.email === "string" ? payment.email.trim().toLowerCase() : "";
    const trustedIntent = await resolveTrustedWalletIntent(supabase, paymentId, checkoutEmail, creditPaise);

    let userIdFromNotes: string;
    let userEmailFromNotes: string;
    let resolutionSource: "trusted_wallet_intent" | "profile_email_match" = "trusted_wallet_intent";

    if (trustedIntent) {
      userIdFromNotes = trustedIntent.userId;
      userEmailFromNotes = trustedIntent.email;
    } else {
      // Fallback: match by checkout email against profiles. This enables auto-credit
      // even when the user paid via the hosted Razorpay button without first clicking
      // through the app (which is what creates the wallet_deposit_intent row).
      if (!checkoutEmail) {
        console.log("Ignoring Razorpay payment with no email and no wallet intent:", paymentId);
        return new Response(JSON.stringify({ ok: true, ignored: "no_email_no_intent" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const { data: profileByEmail, error: emailLookupError } = await supabase
        .from("profiles")
        .select("user_id, email")
        .ilike("email", checkoutEmail)
        .limit(2);

      if (emailLookupError) throw emailLookupError;

      if (!profileByEmail || profileByEmail.length === 0) {
        console.log("Ignoring Razorpay payment with no matching app user:", paymentId, checkoutEmail);
        await notifyTelegram(
          supabase,
          `⚠️ <b>OrganicSMM Pro — Razorpay payment, NO user match</b>\n` +
          `Email: <code>${checkoutEmail}</code>\n` +
          `Amount: <b>₹${amountInr}</b>\n` +
          `Payment ID: <code>${paymentId}</code>\n` +
          `Reason: no profile with that email — credit manually if needed.`,
        );
        return new Response(JSON.stringify({ ok: true, ignored: "no_profile_for_email" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      if (profileByEmail.length > 1) {
        console.error("Multiple profiles share email, refusing auto-credit:", paymentId, checkoutEmail);
        await notifyTelegram(
          supabase,
          `🚫 <b>OrganicSMM Pro — Razorpay payment, ambiguous email</b>\n` +
          `Email: <code>${checkoutEmail}</code>\n` +
          `Amount: <b>₹${amountInr}</b>\n` +
          `Payment ID: <code>${paymentId}</code>\n` +
          `Reason: multiple users share this email, credit manually.`,
        );
        return new Response(JSON.stringify({ ok: true, ignored: "ambiguous_email" }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      userIdFromNotes = profileByEmail[0].user_id as string;
      userEmailFromNotes = checkoutEmail;
      resolutionSource = "profile_email_match";
    }

    let prof: { user_id: string; email: string | null; full_name: string | null } | null = null;

    const { data: profileByUserId, error: profileLookupError } = await supabase
      .from("profiles")
      .select("user_id, email, full_name")
      .eq("user_id", userIdFromNotes)
      .maybeSingle();

    if (profileLookupError) throw profileLookupError;
    prof = profileByUserId;

    if (!prof) {
      console.error("Blocked Razorpay payment with unknown wallet intent user", paymentId, userIdFromNotes);
      return new Response(JSON.stringify({ ok: true, skipped: "unknown_wallet_intent_user" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const profileEmail = typeof prof.email === "string" ? prof.email.trim().toLowerCase() : "";
    if (userEmailFromNotes && profileEmail && userEmailFromNotes !== profileEmail) {
      console.error("Blocked Razorpay payment because noted email does not match profile", paymentId);
      await notifyTelegram(
        supabase,
        `🚫 <b>OrganicSMM Pro — Blocked Razorpay Credit</b>\n` +
        `Amount: <b>₹${amountInr}</b>\n` +
        `Payment ID: <code>${paymentId}</code>\n` +
        `Profile email: <code>${profileEmail}</code>\n` +
        `Checkout email: <code>${userEmailFromNotes}</code>\n` +
        `Reason: email mismatch, wallet NOT credited.`,
      );
      return new Response(JSON.stringify({ ok: true, skipped: "email_mismatch" }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const userId = prof.user_id;

    // ATOMIC credit via SECURITY DEFINER function — handles lock + idempotency + wallet update + tx insert
    // Safe under Razorpay's retry policy because of UNIQUE index on payment_reference.
    const { data: creditResult, error: creditErr } = await supabase.rpc("credit_wallet_razorpay", {
      p_user_id: userId,
      p_payment_id: paymentId,
      p_amount_usd: 0,
      p_amount_inr: amountInr,
    });

    if (creditErr) {
      // Transient DB error — return 5xx so Razorpay retries
      console.error("credit_wallet_razorpay failed:", creditErr.message);
      throw creditErr;
    }

    const credited = (creditResult as any)?.credited === true;
    const duplicate = (creditResult as any)?.duplicate === true;
    const newBalance = Number((creditResult as any)?.new_balance ?? 0);
    const creditedUsd = Number((creditResult as any)?.credited_usd ?? 0);
    const creditedInr = Number((creditResult as any)?.credited_inr ?? amountInr);

    if (duplicate) {
      console.log("Duplicate webhook for payment", paymentId, "— already credited, ack 200");
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!credited) {
      throw new Error(`credit_wallet_razorpay returned unexpected response for ${paymentId}`);
    }

    console.log(`Credited ₹${creditedInr} (db=${creditedUsd} USD) to user ${userId} via ${paymentId}`);

    await notifyTelegram(
      supabase,
      `✅ <b>OrganicSMM Pro — Wallet Credited</b>\n` +
      `User: <b>${escapeTelegramHtml(prof?.full_name)}</b>\n` +
      `Email: <code>${escapeTelegramHtml(prof?.email || userEmailFromNotes)}</code>\n` +
      `Amount: <b>₹${creditedInr.toFixed(2)}</b>\n` +
      `Matched By: <b>${resolutionSource === "trusted_wallet_intent" ? "trusted wallet intent" : "profile email match"}</b>\n` +
      `New Balance: ₹${(newBalance * 83.5).toFixed(2)}\n` +
      `Payment ID: <code>${paymentId}</code>`,
    );

    return new Response(JSON.stringify({ ok: true, credited_inr: creditedInr, credited_usd: creditedUsd }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Webhook error:", err);
    // 5xx triggers Razorpay's automatic retry — the UNIQUE index + RPC make retries safe
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});