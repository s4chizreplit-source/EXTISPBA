// Polls active Instagram accounts for new posts. Auto-orders (mode=auto) or notifies Telegram (mode=manual).
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

async function tgSend(chatId: number, text: string, extra: Record<string, unknown> = {}) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: false, ...extra }),
    });
  } catch (e) { console.error("tg send failed", e); }
}

async function placeOrder(user_id: string, link: string, views: number, likes: number, comments: number, drip_minutes: number) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/instagram-place-engagement`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
    body: JSON.stringify({ user_id, link, views, likes, comments, drip_minutes, source: "poll-auto" }),
  });
  const j = await res.json().catch(() => ({}));
  return { ok: res.ok, ...j };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const runId = crypto.randomUUID().slice(0, 8);
  console.log(`[poll ${runId}] start`);
  try {
    // 1) Load active IG accounts
    const { data: accounts, error: accErr } = await admin
      .from("instagram_accounts")
      .select("id,user_id,username")
      .eq("status", "active");
    if (accErr) throw accErr;
    if (!accounts?.length) {
      return new Response(JSON.stringify({ ok: true, checked: 0 }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const userIds = [...new Set(accounts.map((a) => a.user_id))];

    // 2) Load presets + telegram links SEPARATELY (no FK embeds → no PGRST200)
    const [{ data: presets }, { data: tgLinks }] = await Promise.all([
      admin.from("engagement_presets").select("*").in("user_id", userIds),
      admin.from("telegram_engagement_links").select("user_id,telegram_chat_id,status").in("user_id", userIds).eq("status", "linked"),
    ]);
    const presetMap = new Map<string, any>();
    (presets ?? []).forEach((p: any) => presetMap.set(p.user_id, p));
    const tgMap = new Map<string, number>();
    (tgLinks ?? []).forEach((t: any) => tgMap.set(t.user_id, Number(t.telegram_chat_id)));

    // 3) Load poll state
    const accountIds = accounts.map((a) => a.id);
    const { data: states } = await admin.from("instagram_poll_state").select("*").in("account_id", accountIds);
    const stateMap = new Map<string, any>();
    (states ?? []).forEach((s: any) => stateMap.set(s.account_id, s));

    let ordersPlaced = 0;
    let notified = 0;

    for (const acc of accounts) {
      const preset = presetMap.get(acc.user_id);
      const chatId = tgMap.get(acc.user_id);

      // Trigger media refresh (best-effort, non-blocking wait — but we need latest before compare)
      try {
        await fetch(`${SUPABASE_URL}/functions/v1/instagram-refresh-media`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
          body: JSON.stringify({ account_id: acc.id, results_limit: 10 }),
        });
      } catch (e) { console.error(`[poll ${runId}] refresh failed for ${acc.username}`, e); }

      const { data: media } = await admin
        .from("instagram_media")
        .select("media_id,shortcode,permalink,posted_at")
        .eq("account_id", acc.id)
        .order("posted_at", { ascending: false, nullsFirst: false })
        .limit(5);

      if (!media?.length) continue;
      const latest = media[0];
      const st = stateMap.get(acc.id);
      const lastSeen = st?.last_seen_media_id ?? null;

      // Update state to latest (always) so first-time accounts don't back-order history
      await admin.from("instagram_poll_state").upsert({
        account_id: acc.id,
        last_seen_media_id: latest.media_id,
        last_polled_at: new Date().toISOString(),
      });

      // First-ever poll: just record, don't order
      if (!lastSeen) continue;
      if (lastSeen === latest.media_id) continue;

      // New posts: those posted after lastSeen, up to 3 newest
      const newPosts = [];
      for (const m of media) {
        if (m.media_id === lastSeen) break;
        newPosts.push(m);
      }
      if (!newPosts.length) continue;

      for (const np of newPosts.slice(0, 3)) {
        const link = np.permalink;
        const shortcode = np.shortcode ?? "";

        if (preset?.mode === "auto" && (preset.views + preset.likes + preset.comments) > 0) {
          const r = await placeOrder(acc.user_id, link, preset.views ?? 0, preset.likes ?? 0, preset.comments ?? 0, preset.drip_minutes ?? 0);
          if (r.ok) {
            ordersPlaced++;
            if (chatId) {
              await tgSend(chatId, `🚀 Auto-order placed on new post by @${acc.username}\n<a href="${link}">${shortcode}</a>\nCharged: ₹${r.charged_inr ?? "?"}`);
            }
          } else {
            console.error(`[poll ${runId}] auto-order failed`, r);
            if (chatId) await tgSend(chatId, `⚠️ Auto-order failed for @${acc.username}: ${r.error ?? "unknown"}`);
          }
        } else if (chatId) {
          // Manual mode: send inline buttons
          const kb = {
            inline_keyboard: [
              [{ text: "🚀 Apply preset", callback_data: `apply:${shortcode}:all` }],
              [{ text: "✏️ Custom quantities", callback_data: `post:${shortcode}` }],
            ],
          };
          await tgSend(chatId, `🆕 New post by @${acc.username}\n<a href="${link}">${shortcode}</a>`, { reply_markup: kb });
          notified++;
        }
      }
    }

    console.log(`[poll ${runId}] done: ${accounts.length} accounts, ${ordersPlaced} auto-orders, ${notified} notified`);
    return new Response(JSON.stringify({ ok: true, checked: accounts.length, ordersPlaced, notified }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error(`[poll ${runId}] error`, e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
