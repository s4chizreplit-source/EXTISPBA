// Shared helper to record blocked/rejected security events into
// public.security_audit_log. Fire-and-forget: never throws so it can't break
// the calling handler.
//
// High-severity events (webhook forgery/replay/invalid signature/unverified
// status) additionally trigger an admin Telegram notification. Repeated
// replay/forgery attempts against the same order_id/track_id are escalated
// as a "burst" alert.
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type AuditCategory =
  | "webhook_forgery"
  | "webhook_replay"
  | "webhook_invalid_signature"
  | "webhook_unverified_status"
  | "webhook_missing_field"
  | "webhook_processing_failure"
  | "payment_gate_denied"
  | "rpc_denied"
  | "rls_denied";

export interface AuditEntry {
  category: AuditCategory;
  source: string;
  reason: string;
  provider?: string | null;
  order_id?: string | null;
  track_id?: string | null;
  user_id?: string | null;
  http_status?: number | null;
  request?: Request | null;
  payload?: any;
  metadata?: Record<string, unknown>;
}

// Categories that warrant immediate admin Telegram alert.
const HIGH_SEVERITY: ReadonlySet<AuditCategory> = new Set([
  "webhook_forgery",
  "webhook_replay",
  "webhook_invalid_signature",
  "webhook_unverified_status",
  "webhook_processing_failure",
]);

// Per-instance throttle so a flood of retries from one attacker doesn't spam
// Telegram. Key = category+identifier, value = last-notified timestamp.
const notifyCache = new Map<string, number>();
const NOTIFY_THROTTLE_MS = 60_000; // 1 minute per (category,id)
const BURST_WINDOW_MS = 10 * 60_000; // look-back window for burst detection
const BURST_THRESHOLD = 3; // >=3 rejected attempts in window => burst

function throttleKey(entry: AuditEntry): string {
  const id =
    entry.order_id ||
    entry.track_id ||
    entry.user_id ||
    entry.request?.headers.get("cf-connecting-ip") ||
    "unknown";
  return `${entry.category}:${id}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramAlert(text: string): Promise<void> {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN");
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID");
  if (!token || !chatId) {
    console.warn("[security-audit] Telegram not configured; skipping alert");
    return;
  }
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[security-audit] Telegram send failed ${res.status}: ${body}`);
    }
  } catch (e) {
    console.error("[security-audit] Telegram send threw", e);
  }
}

async function detectBurst(
  admin: SupabaseClient,
  entry: AuditEntry,
): Promise<number> {
  // Count recent rejected attempts sharing the same identifier.
  const identifierFilter = entry.order_id
    ? { column: "order_id", value: entry.order_id }
    : entry.track_id
      ? { column: "track_id", value: entry.track_id }
      : null;
  if (!identifierFilter) return 0;
  try {
    const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
    const { count } = await admin
      .from("security_audit_log")
      .select("id", { count: "exact", head: true })
      .eq(identifierFilter.column, identifierFilter.value)
      .in("category", [
        "webhook_forgery",
        "webhook_replay",
        "webhook_invalid_signature",
        "webhook_unverified_status",
      ])
      .gte("created_at", since);
    return count ?? 0;
  } catch (e) {
    console.error("[security-audit] burst count failed", e);
    return 0;
  }
}

async function maybeNotifyAdmin(
  admin: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  if (!HIGH_SEVERITY.has(entry.category)) return;

  const key = throttleKey(entry);
  const now = Date.now();
  const last = notifyCache.get(key) ?? 0;
  const throttled = now - last < NOTIFY_THROTTLE_MS;

  const burstCount = await detectBurst(admin, entry);
  const isBurst = burstCount >= BURST_THRESHOLD;

  // Skip if throttled AND not an escalating burst.
  if (throttled && !isBurst) return;
  notifyCache.set(key, now);

  const ip =
    entry.request?.headers.get("cf-connecting-ip") ||
    entry.request?.headers.get("x-real-ip") ||
    entry.request?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const title = isBurst
    ? `🚨 <b>SECURITY BURST</b> — ${burstCount} recent attempts`
    : `⚠️ <b>Security Alert</b>`;

  const lines = [
    title,
    ``,
    `<b>Category:</b> ${escapeHtml(entry.category)}`,
    `<b>Source:</b> ${escapeHtml(entry.source)}`,
    `<b>Reason:</b> ${escapeHtml(entry.reason)}`,
  ];
  if (entry.provider) lines.push(`<b>Provider:</b> ${escapeHtml(entry.provider)}`);
  if (entry.order_id) lines.push(`<b>Order:</b> <code>${escapeHtml(entry.order_id)}</code>`);
  if (entry.track_id) lines.push(`<b>Track:</b> <code>${escapeHtml(entry.track_id)}</code>`);
  if (entry.user_id) lines.push(`<b>User:</b> <code>${escapeHtml(entry.user_id)}</code>`);
  if (entry.http_status) lines.push(`<b>Status:</b> ${entry.http_status}`);
  lines.push(`<b>IP:</b> <code>${escapeHtml(ip)}</code>`);
  lines.push(`<b>Time:</b> ${new Date().toISOString()}`);
  if (isBurst) {
    lines.push(
      ``,
      `⏱ ${burstCount} rejected attempts on this identifier in the last ${BURST_WINDOW_MS / 60000} minutes.`,
      `Review the Security Audit page in the admin panel.`,
    );
  }

  await sendTelegramAlert(lines.join("\n"));
}

export async function recordSecurityEvent(
  admin: SupabaseClient,
  entry: AuditEntry,
): Promise<void> {
  try {
    const req = entry.request;
    const ip =
      req?.headers.get("cf-connecting-ip") ||
      req?.headers.get("x-real-ip") ||
      req?.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
      null;
    const ua = req?.headers.get("user-agent") || null;
    const path = req ? new URL(req.url).pathname : null;

    await admin.from("security_audit_log").insert({
      category: entry.category,
      source: entry.source,
      reason: entry.reason,
      provider: entry.provider ?? null,
      order_id: entry.order_id ?? null,
      track_id: entry.track_id ?? null,
      user_id: entry.user_id ?? null,
      http_status: entry.http_status ?? null,
      ip,
      user_agent: ua,
      request_path: path,
      payload: entry.payload ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (e) {
    console.error("[security-audit] insert failed", e);
  }

  // Fire-and-forget admin alert (must never throw into caller).
  try {
    await maybeNotifyAdmin(admin, entry);
  } catch (e) {
    console.error("[security-audit] notify failed", e);
  }
}
