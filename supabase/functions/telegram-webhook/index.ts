// Telegram bot webhook: linking + posts + orders + presets + inline callbacks
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

async function tg(method: string, body: Record<string, unknown>) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
const reply = (chatId: number, text: string, extra: Record<string, unknown> = {}) =>
  tg("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, ...extra });

async function getLinkedUser(chatId: number) {
  const { data } = await supabase.from("telegram_engagement_links").select("user_id").eq("telegram_chat_id", chatId).eq("status", "linked").maybeSingle();
  return data?.user_id as string | undefined;
}

type QtyMap = { views: number; likes: number; comments: number; saves: number; shares: number; reposts: number };
const ENG_TYPES: (keyof QtyMap)[] = ["views", "likes", "comments", "saves", "shares", "reposts"];
const emptyQty = (): QtyMap => ({ views: 0, likes: 0, comments: 0, saves: 0, shares: 0, reposts: 0 });
const sumQty = (q: QtyMap) => ENG_TYPES.reduce((s, k) => s + (q[k] || 0), 0);

async function placeEngagement(user_id: string, link: string, qty: QtyMap, drip_minutes = 0) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/instagram-place-engagement`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${SERVICE_KEY}`, apikey: SERVICE_KEY },
    body: JSON.stringify({ user_id, link, ...qty, drip_minutes, source: "telegram" }),
  });
  return { ok: res.ok, ...(await res.json().catch(() => ({}))) };
}

type Limit = { min: number; max: number };
async function getIgServiceLimits(): Promise<{ limits: Record<string, Limit>; err?: string }> {
  const { data: bundle, error: bErr } = await supabase
    .from("engagement_bundles")
    .select("id,bundle_items(engagement_type,service_id)")
    .eq("platform", "instagram").eq("is_active", true).maybeSingle();
  if (bErr) return { limits: {}, err: `bundle load failed: ${bErr.message}` };
  if (!bundle) return { limits: {}, err: "Instagram bundle not configured" };
  const items = ((bundle as any).bundle_items ?? []) as Array<{ engagement_type: string; service_id: string }>;
  const ids = items.map((i) => i.service_id).filter(Boolean);
  if (!ids.length) return { limits: {}, err: "Instagram bundle has no services" };
  const { data: svcs, error: sErr } = await supabase
    .from("services").select("id,min_quantity,max_quantity").in("id", ids);
  if (sErr) return { limits: {}, err: `service load failed: ${sErr.message}` };
  const byId = new Map((svcs ?? []).map((s: any) => [s.id, s]));
  const limits: Record<string, Limit> = {};
  for (const it of items) {
    const s: any = byId.get(it.service_id);
    if (!s) continue;
    limits[it.engagement_type] = {
      min: Math.max(0, Number(s.min_quantity) || 0),
      max: Math.max(1, Number(s.max_quantity) || 1_000_000),
    };
  }
  return { limits };
}

async function findMediaByShortcode(userId: string, shortcode: string) {
  const { data } = await supabase.from("instagram_media").select("permalink,shortcode").eq("user_id", userId).eq("shortcode", shortcode).maybeSingle();
  return data;
}

async function handleCommand(chatId: number, username: string | null, text: string) {
  const [cmdRaw, ...args] = text.trim().split(/\s+/);
  const cmd = cmdRaw.split("@")[0].toLowerCase();

  if (cmd === "/start" || cmd === "/help") {
    return reply(chatId,
      `<b>OrganicSMM Pro Bot</b>\n\n` +
      `<b>Account</b>\n` +
      `<code>/link CODE</code> — pair account\n` +
      `<code>/wallet</code> — balance\n` +
      `<code>/b</code> — provider live balance (admin)\n` +

      `<code>/posts</code> — recent IG posts\n` +
      `<code>/orders</code> — recent orders\n` +
      `<code>/cancel ID</code> — cancel pending order\n\n` +
      `<b>Defaults (auto-apply on /order)</b>\n` +
      `<code>/setlink &lt;link&gt;</code> — default post\n` +
      `<code>/setdefault V L C [SV SH RP] [DRIP]</code> — default quantities\n` +
      `   or flags: <code>/setdefault v=5000 l=500 sv=100 drip=60</code>\n` +
      `<code>/mode auto|manual</code> — auto-order on new posts\n` +
      `<code>/mydefaults</code> — show saved defaults\n\n` +
      `<b>/order — place engagement</b>\n` +
      `You only pay for what you type. Skip a type = 0 = no order for it.\n\n` +
      `Positional (in order): <b>V L C SAVES SHARES REPOSTS [DRIP]</b>\n` +
      `1. <code>/order</code> — saved link + saved qty\n` +
      `2. <code>/order &lt;link&gt;</code> — saved qty on this link\n` +
      `3. <code>/order &lt;link&gt; 5000</code> — only 5000 views\n` +
      `4. <code>/order &lt;link&gt; 5000 500</code> — views + likes\n` +
      `5. <code>/order &lt;link&gt; 5000 500 50</code> — V + L + C\n` +
      `6. <code>/order &lt;link&gt; 5000 500 50 100 50 20</code> — all 6\n\n` +
      `Flag form (any order): <code>/order &lt;link&gt; v=5000 sv=100 drip=60</code>\n` +
      `Keys: <code>v l c sv sh rp drip</code>\n\n` +
      `<b>Rules</b>\n` +
      `• Each qty 0 – 1,000,000 (at least one &gt; 0)\n` +
      `• DRIP optional: 0–1440 minutes\n` +
      `• Saves/Shares/Reposts require admin to enable those services\n\n` +
      `Get CODE from app → More → Telegram Bot.`);
  }

  if (cmd === "/link") {
    const code = args[0];
    if (!code) return reply(chatId, "Usage: <code>/link YOURCODE</code>");
    const { data, error } = await supabase.rpc("redeem_telegram_link_code", { p_code: code, p_chat_id: chatId, p_username: username ?? "" });
    if (error) return reply(chatId, `❌ ${error.message}`);
    if (!data?.success) return reply(chatId, `❌ Link failed: ${data?.reason ?? "unknown"}`);
    return reply(chatId, "✅ Linked! Try /wallet or /posts.");
  }

  // Admin: live provider balance (only the configured admin chat reaches here)
  if (cmd === "/b" || cmd === "/balance") {
    const { data: accounts, error } = await supabase
      .from("provider_accounts")
      .select("id,name,api_key,api_url,priority,is_active,balance_currency")
      .eq("is_active", true)
      .order("priority", { ascending: true });
    if (error) return reply(chatId, `❌ ${error.message}`);
    if (!accounts?.length) return reply(chatId, "⚠️ Koi active provider account nahi mila.");

    await reply(chatId, "⏳ Live balance check kar raha hu...");

    const usdToInr = await (async () => {
      try {
        const r = await fetch("https://api.exchangerate-api.com/v4/latest/USD");
        const j = await r.json();
        const rate = Number(j?.rates?.INR);
        if (rate > 0) return rate;
      } catch { /* fallback below */ }
      return 84;
    })();

    const lines: string[] = [];
    let totalInr = 0;
    for (const acc of accounts as any[]) {
      const tag = acc.priority === (accounts as any[])[0].priority ? " ⭐ MAIN" : "";
      try {
        const form = new URLSearchParams({ key: acc.api_key, action: "balance" });
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 12000);
        const resp = await fetch(acc.api_url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form.toString(),
          signal: controller.signal,
        });
        clearTimeout(t);
        const text = await resp.text();
        let data: any;
        try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 120) }; }
        if (data?.error) {
          lines.push(`❌ <b>${acc.name}</b>${tag}\n   ${String(data.error).slice(0, 120)}`);
          continue;
        }
        const bal = Number(data.balance ?? 0);
        const currency = String(data.currency ?? acc.balance_currency ?? "USD").toUpperCase();
        const inr = currency === "USD" ? bal * usdToInr : bal;
        totalInr += inr;
        const low = inr < 50 ? " ⚠️ LOW" : "";
        lines.push(
          `${inr < 50 ? "⚠️" : "✅"} <b>${acc.name}</b>${tag}\n` +
          `   ₹${inr.toFixed(2)}${currency === "USD" ? ` (${bal.toFixed(4)} USD)` : ""}${low}`,
        );
        await supabase.from("provider_accounts").update({
          balance: bal,
          balance_currency: currency,
          balance_checked_at: new Date().toISOString(),
          last_balance_error: null,
        }).eq("id", acc.id);
      } catch (e: any) {
        lines.push(`❌ <b>${acc.name}</b>${tag}\n   ${(e?.message || "network error").slice(0, 120)}`);
      }
    }

    return reply(chatId,
      `💳 <b>Provider Live Balance</b>\n\n${lines.join("\n\n")}\n\n` +
      `<b>Total:</b> ₹${totalInr.toFixed(2)}\n` +
      `<i>Rate: 1 USD = ₹${usdToInr.toFixed(2)} · ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</i>`);
  }

  const userId = await getLinkedUser(chatId);
  if (!userId) return reply(chatId, "🔒 Not linked. App → More → Telegram Bot → copy code → <code>/link CODE</code>.");

  if (cmd === "/wallet") {
    const { data: w } = await supabase.from("wallets").select("balance,total_spent").eq("user_id", userId).maybeSingle();
    const inr = (v: number) => `₹${(v * 83.5).toFixed(2)}`;
    return reply(chatId, `💰 <b>Wallet</b>\nBalance: ${inr(Number(w?.balance ?? 0))}\nTotal Spent: ${inr(Number(w?.total_spent ?? 0))}`);
  }


  // shared: parse V/L/C/SV/SH/RP/DRIP from either flag (k=v) or positional
  const KEY_ALIAS: Record<string, keyof QtyMap | "drip"> = {
    v: "views", views: "views",
    l: "likes", likes: "likes",
    c: "comments", comments: "comments",
    sv: "saves", saves: "saves",
    sh: "shares", shares: "shares",
    rp: "reposts", reposts: "reposts",
    d: "drip", drip: "drip",
  };
  const parseQtyArgs = (tokens: string[]): { qty: QtyMap; drip: number | null; err?: string } => {
    const qty = emptyQty();
    let drip: number | null = null;
    const hasFlag = tokens.some((t) => t.includes("="));
    if (hasFlag) {
      for (const t of tokens) {
        const [rawK, rawV] = t.split("=");
        if (!rawV) return { qty, drip, err: `Bad flag: "${t}"` };
        const key = KEY_ALIAS[rawK.toLowerCase()];
        if (!key) return { qty, drip, err: `Unknown key: "${rawK}"` };
        if (!/^\d+$/.test(rawV)) return { qty, drip, err: `"${rawK}" must be a whole number, got "${rawV}"` };
        const n = Number(rawV);
        if (n < 0 || n > 1_000_000) return { qty, drip, err: `"${rawK}"=${n} out of range (0–1,000,000)` };
        if (key === "drip") drip = Math.min(1440, n);
        else qty[key] = n;
      }
    } else {
      // positional: V L C SV SH RP [DRIP]
      for (let i = 0; i < tokens.length; i++) {
        const s = tokens[i];
        if (!/^\d+$/.test(s)) return { qty, drip, err: `Arg ${i + 1} not a number: "${s}"` };
        const n = Number(s);
        if (n < 0 || n > 1_000_000) return { qty, drip, err: `Arg ${i + 1}=${n} out of range` };
        if (i < 6) qty[ENG_TYPES[i]] = n;
        else if (i === 6) drip = Math.min(1440, n);
        else return { qty, drip, err: "Too many arguments (max 7 numbers after link)" };
      }
    }
    return { qty, drip };
  };

  if (cmd === "/setdefault") {
    if (args.length === 0) return reply(chatId, "Usage:\n<code>/setdefault V L C [SV SH RP] [DRIP]</code>\nor flags: <code>/setdefault v=5000 l=500 sv=100 drip=60</code>");
    const { qty, drip, err } = parseQtyArgs(args);
    if (err) return reply(chatId, `❌ ${err}`);
    const payload: any = { user_id: userId, ...qty };
    if (drip !== null) payload.drip_minutes = drip;
    const { error } = await supabase.from("engagement_presets").upsert(payload);
    if (error) return reply(chatId, `❌ ${error.message}`);
    const list = ENG_TYPES.map((k) => `${k}: ${qty[k]}`).join(" · ");
    return reply(chatId, `✅ Defaults saved.\n${list}${drip !== null ? `\nDrip: ${drip}m` : ""}\n\nAb <code>/order</code> chalao — sirf non-zero types ka order lagega.`);
  }

  if (cmd === "/setlink") {
    const link = args[0];
    if (!link) return reply(chatId, "Usage: <code>/setlink &lt;instagram-link&gt;</code>");
    if (!/^https?:\/\/(www\.)?instagram\.com\/(p|reel|tv)\/[A-Za-z0-9_-]+/i.test(link)) {
      return reply(chatId, "❌ Invalid link. Must be an Instagram post/reel URL.");
    }
    if (link.length > 300) return reply(chatId, "❌ Link too long (max 300 chars).");
    const { error } = await supabase.from("engagement_presets").upsert({ user_id: userId, default_link: link });
    if (error) return reply(chatId, `❌ ${error.message}`);
    return reply(chatId, `✅ Default link saved.\n<code>${link}</code>\n\nAb <code>/order</code> sirf likhne se hi order lag jayega.`);
  }

  if (cmd === "/cleardefaults") {
    const { error } = await supabase.from("engagement_presets").upsert({ user_id: userId, default_link: null });
    if (error) return reply(chatId, `❌ ${error.message}`);
    return reply(chatId, "✅ Default link cleared. Quantities aur mode intact hain.");
  }

  if (cmd === "/mydefaults") {
    const { data: p } = await supabase.from("engagement_presets").select("*").eq("user_id", userId).maybeSingle();
    if (!p) return reply(chatId, "No defaults saved yet.\nUse <code>/setdefault</code>, <code>/setlink</code>, <code>/mode</code>.");
    const qtyLine = ENG_TYPES.map((k) => `${k}: ${(p as any)[k] ?? 0}`).join(" · ");
    return reply(chatId,
      `<b>Your defaults</b>\nMode: <code>${p.mode ?? "manual"}</code>\nLink: ${p.default_link ? `<code>${p.default_link}</code>` : "<i>(not set)</i>"}\n${qtyLine}\nDrip: ${p.drip_minutes ?? 0}m`);
  }

  if (cmd === "/mode") {
    const m = (args[0] ?? "").toLowerCase();
    if (!["auto", "manual"].includes(m)) return reply(chatId, "Usage: <code>/mode auto</code> or <code>/mode manual</code>");
    const { error } = await supabase.from("engagement_presets").upsert({ user_id: userId, mode: m });
    if (error) return reply(chatId, `❌ ${error.message}`);
    return reply(chatId, `✅ Mode set to <b>${m}</b>.`);
  }

  if (cmd === "/order") {
    const EX_FULL = "/order https://instagram.com/p/ABC123/ 5000 500 50";
    // Consistent error formatter: emoji header + bullet lines
    const orderErr = (o: {
      icon?: string; title: string; problem?: string; fix?: string; example?: string; extra?: string;
    }) => {
      const lines = [`${o.icon ?? "❌"} <b>${o.title}</b>`];
      if (o.problem) lines.push(`• <b>Problem:</b> ${o.problem}`);
      if (o.fix) lines.push(`• <b>Fix:</b> ${o.fix}`);
      if (o.example) lines.push(`• <b>Example:</b> <code>${o.example}</code>`);
      if (o.extra) lines.push(o.extra);
      return reply(chatId, lines.join("\n"));
    };

    // Reject too many args early so users don't silently drop values
    if (args.length > 8) {
      return orderErr({
        title: "Too many arguments",
        problem: `You sent ${args.length} arguments (max: link + 6 quantities + drip = 8).`,
        fix: "Remove extras or wrap the link if it has spaces.",
        example: EX_FULL,
      });
    }

    // Load preset once — used for defaults on link + quantities
    const { data: preset, error: presetErr } = await supabase
      .from("engagement_presets").select("*").eq("user_id", userId).maybeSingle();
    if (presetErr) return orderErr({
      title: "Could not load your saved defaults",
      problem: presetErr.message,
      fix: "Try again in a few seconds. If it persists, contact support.",
    });

    // ---------- 1. Resolve + validate LINK ----------
    let link = args[0];
    let linkSource: "arg" | "preset" = "arg";
    // If first arg is a k=v flag (or a bare number), no link was passed inline
    if (link && (link.includes("=") || /^\d+$/.test(link))) {
      link = undefined as any;
    }
    if (!link) {
      if (!preset?.default_link) {
        return orderErr({
          title: "No link given and no default link saved",
          problem: "Bot doesn't know which post to boost.",
          fix: "Save a default with <code>/setlink &lt;instagram-link&gt;</code>, or pass one inline.",
          example: "/order https://instagram.com/p/ABC123/",
        });
      }
      link = preset.default_link as string;
      linkSource = "preset";
    } else {
      // consume args[0] as link → shift remaining
      args.shift();
    }

    // strip common wrapping chars
    link = link.trim().replace(/^[<"']|[>"']$/g, "");

    if (link.length > 300) {
      return orderErr({
        title: "Link too long",
        problem: `${link.length} chars (max 300).`,
        fix: "Copy the URL directly from Instagram — remove tracking/query suffix.",
        example: "https://instagram.com/p/ABC123/",
      });
    }

    let parsedUrl: URL;
    try { parsedUrl = new URL(link); }
    catch {
      return orderErr({
        title: "Link is not a valid URL",
        problem: `Could not parse: <code>${link}</code>`,
        fix: "Must start with <code>https://</code> and be a full Instagram post/reel URL.",
        example: "https://instagram.com/p/ABC123/",
      });
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      return orderErr({
        title: "Link must use https://",
        problem: `Got protocol <code>${parsedUrl.protocol}</code>.`,
        fix: "Use the standard https Instagram URL.",
        example: "https://instagram.com/p/ABC123/",
      });
    }
    const host = parsedUrl.hostname.toLowerCase().replace(/^www\./, "");
    if (host !== "instagram.com") {
      return orderErr({
        title: "Only Instagram links are supported",
        problem: `Got host <code>${host}</code>.`,
        fix: "Use a public instagram.com post/reel URL.",
        example: "https://instagram.com/p/ABC123/",
      });
    }
    const pathMatch = parsedUrl.pathname.match(/^\/(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})\/?/);
    if (!pathMatch) {
      return orderErr({
        title: "Not a post/reel URL",
        problem: `Path <code>${parsedUrl.pathname}</code> doesn't match a post/reel.`,
        fix: "Path must be <code>/p/&lt;code&gt;/</code>, <code>/reel/&lt;code&gt;/</code> or <code>/tv/&lt;code&gt;/</code>.",
        example: "https://instagram.com/reel/XYZ456/",
      });
    }
    link = `https://instagram.com/${pathMatch[1]}/${pathMatch[2]}/`;

    // ---------- 2. Resolve QUANTITIES + DRIP (positional or flag) ----------
    let qty: QtyMap;
    let drip = 0;
    let qtySource: "arg" | "preset" = "arg";
    if (args.length > 0) {
      const parsed = parseQtyArgs(args);
      if (parsed.err) return orderErr({
        title: "Invalid quantity",
        problem: parsed.err,
        fix: "Use digits only. Skip a type by leaving it at 0.",
        example: EX_FULL,
      });
      qty = parsed.qty;
      drip = parsed.drip !== null ? parsed.drip : Math.max(0, Math.floor(Number(preset?.drip_minutes) || 0));
      if (sumQty(qty) === 0) return orderErr({
        title: "All quantities are zero",
        problem: "You didn't request any engagement.",
        fix: "Set at least one type &gt; 0.",
        example: EX_FULL,
      });
    } else {
      if (!preset) return orderErr({
        title: "No quantities given and no preset saved",
        fix: "Save a preset with <code>/setdefault V L C [SV SH RP] [DRIP]</code>, or pass values inline.",
        example: EX_FULL,
      });
      qty = {
        views: Math.max(0, Math.floor(Number((preset as any).views) || 0)),
        likes: Math.max(0, Math.floor(Number((preset as any).likes) || 0)),
        comments: Math.max(0, Math.floor(Number((preset as any).comments) || 0)),
        saves: Math.max(0, Math.floor(Number((preset as any).saves) || 0)),
        shares: Math.max(0, Math.floor(Number((preset as any).shares) || 0)),
        reposts: Math.max(0, Math.floor(Number((preset as any).reposts) || 0)),
      };
      if (sumQty(qty) === 0) return orderErr({
        title: "Your saved preset has all zero quantities",
        fix: "Update with <code>/setdefault V L C [SV SH RP]</code>, or pass values inline.",
        example: EX_FULL,
      });
      drip = Math.max(0, Math.floor(Number((preset as any).drip_minutes) || 0));
      qtySource = "preset";
    }
    if (drip > 1440) drip = 1440;

    // ---------- 3. Service-wise min/max enforcement (only for requested types) ----------
    const { limits, err: limErr } = await getIgServiceLimits();
    if (limErr) return orderErr({
      title: "Cannot verify service limits right now",
      problem: limErr,
      fix: "Try again in a few seconds.",
    });
    const fmt = (n: number) => n.toLocaleString();
    const LABEL: Record<keyof QtyMap, string> = {
      views: "Views", likes: "Likes", comments: "Comments",
      saves: "Saves", shares: "Shares", reposts: "Reposts",
    };
    for (const t of ENG_TYPES) {
      const q = qty[t];
      if (q <= 0) continue;
      const lim = limits[t];
      if (!lim) return orderErr({
        title: `${LABEL[t]} service unavailable`,
        problem: `Not configured for Instagram right now.`,
        fix: `Use <code>0</code> for ${LABEL[t].toLowerCase()}, or ask admin to enable it.`,
      });
      if (q < lim.min) return orderErr({
        title: `${LABEL[t]} quantity below minimum`,
        problem: `You asked for ${fmt(q)}.`,
        fix: `Use a value in range <b>${fmt(lim.min)} – ${fmt(lim.max)}</b>, or 0 to skip.`,
      });
      if (q > lim.max) return orderErr({
        title: `${LABEL[t]} quantity above maximum`,
        problem: `You asked for ${fmt(q)}.`,
        fix: `Use a value in range <b>${fmt(lim.min)} – ${fmt(lim.max)}</b>.`,
      });
    }

    // ---------- 4. Duplicate-submission guard ----------
    const lockKey = `tg:order:${chatId}:${link}`;
    if ((globalThis as any).__tgOrderLocks instanceof Set === false) {
      (globalThis as any).__tgOrderLocks = new Set<string>();
    }
    const locks: Set<string> = (globalThis as any).__tgOrderLocks;
    if (locks.has(lockKey)) {
      return orderErr({
        icon: "⏳",
        title: "Order already in progress",
        problem: "A previous /order for this link is still executing.",
        fix: "Wait a few seconds, then retry.",
      });
    }
    const since = new Date(Date.now() - 90_000).toISOString();
    const { data: dupes, error: dupeErr } = await supabase
      .from("engagement_orders")
      .select("id,order_number,status,created_at,total_price")
      .eq("user_id", userId).eq("link", link).gte("created_at", since)
      .order("created_at", { ascending: false }).limit(1);
    if (dupeErr) return orderErr({
      title: "Duplicate check failed",
      problem: dupeErr.message,
      fix: "Try again shortly.",
    });
    if (dupes && dupes.length > 0) {
      const d: any = dupes[0];
      const ageSec = Math.max(1, Math.round((Date.now() - new Date(d.created_at).getTime()) / 1000));
      return orderErr({
        icon: "⚠️",
        title: "Duplicate order blocked",
        problem: `Identical order placed ${ageSec}s ago: <code>#${d.order_number}</code> · ${d.status}.`,
        fix: `Check with <code>/status ${d.order_number}</code>. Retry after 90s if you really want a second order.`,
      });
    }

    // ---------- 5. Place order ----------
    locks.add(lockKey);
    const r = await placeEngagement(userId, link, qty, drip).finally(() => locks.delete(lockKey));
    if (!r.ok) {
      const rawMsg = String(r.error ?? "Order failed");
      let fix = "Try again in a few seconds.";
      if (/insufficient|balance|wallet/i.test(rawMsg)) fix = "Top up wallet in the app, then retry.";
      else if (/subscription|plan/i.test(rawMsg)) fix = "Activate a plan (Monthly / Lifetime) to place orders.";
      else if (/service|provider|mapping/i.test(rawMsg)) fix = "Service temporarily unavailable — try again in a few minutes.";
      else if (/rate|limit|too many/i.test(rawMsg)) fix = "Slow down — you're hitting the rate limit.";
      return orderErr({ title: "Order failed", problem: rawMsg, fix });
    }
    const src = `${linkSource === "preset" ? "saved link" : "inline link"} · ${qtySource === "preset" ? "saved qty" : "inline qty"}`;
    const qtyLine = ENG_TYPES.filter((t) => qty[t] > 0).map((t) => `<b>${LABEL[t]}:</b> ${qty[t]}`).join(" · ");
    return reply(chatId, `✅ <b>Order placed</b>\n• <b>ID:</b> <code>#${r.order_number}</code>\n• <b>Link:</b> <code>${link}</code>\n• ${qtyLine}${drip ? `\n• <b>Drip:</b> ${drip}m` : ""}\n• <b>Charged:</b> ₹${r.charged_inr}\n<i>${src}</i>`);
  }



  if (cmd === "/posts") {
    const { data: posts } = await supabase.rpc("get_posts_with_order_summary", { _user_id: userId });
    const rows = (posts ?? []).slice(0, 6);
    if (rows.length === 0) return reply(chatId, "No posts yet. Link IG in app.");
    for (const p of rows as any[]) {
      const kb = {
        inline_keyboard: [
          [{ text: "🚀 Apply preset", callback_data: `apply:${p.shortcode}:all` }],
          [{ text: "✏️ Custom", callback_data: `post:${p.shortcode}` }],
        ],
      };
      await reply(chatId, `<a href="${p.permalink}">${p.shortcode}</a>\n${p.active_orders} active / ${p.completed_orders} done`, { reply_markup: kb });
    }
    return;
  }

  if (cmd === "/orders") {
    const { data: orders } = await supabase.from("engagement_orders").select("id,order_number,link,status,total_price,created_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(8);
    if (!orders?.length) return reply(chatId, "No orders yet.");
    const list = orders.map((o: any) => `<code>#${o.order_number}</code> · ${o.status} · ₹${(Number(o.total_price) * 83.5).toFixed(2)}\n<a href="${o.link}">link</a>`).join("\n\n");
    return reply(chatId, `<b>Recent Orders</b>\n\n${list}`);
  }

  if (cmd === "/status") {
    const n = Number(args[0]);
    if (!n) return reply(chatId, "Usage: <code>/status ORDER_NUMBER</code>");
    const { data: o } = await supabase.from("engagement_orders").select("order_number,status,total_price,link").eq("user_id", userId).eq("order_number", n).maybeSingle();
    if (!o) return reply(chatId, "Not found.");
    return reply(chatId, `<b>Order #${o.order_number}</b>\nStatus: ${o.status}\nAmount: ₹${(Number(o.total_price) * 83.5).toFixed(2)}\n<a href="${o.link}">link</a>`);
  }

  if (cmd === "/cancel") {
    const cancelErr = (o: {
      icon?: string; title: string; problem?: string; fix?: string; example?: string; extra?: string;
    }) => {
      const lines = [`${o.icon ?? "❌"} <b>${o.title}</b>`];
      if (o.problem) lines.push(`• <b>Problem:</b> ${o.problem}`);
      if (o.fix) lines.push(`• <b>Fix:</b> ${o.fix}`);
      if (o.example) lines.push(`• <b>Example:</b> <code>${o.example}</code>`);
      if (o.extra) lines.push(o.extra);
      return reply(chatId, lines.join("\n"));
    };

    const raw = args[0];
    const n = Number(raw);
    if (!raw || !Number.isInteger(n) || n <= 0) {
      return cancelErr({
        title: "Invalid order number",
        problem: raw ? `<code>${raw}</code> is not a valid order number.` : "No order number provided.",
        fix: "Send <code>/cancel</code> followed by a positive order number. Use <code>/orders</code> to list your recent IDs.",
        example: "/cancel 123",
      });
    }

    const { data: match, error: findErr } = await supabase
      .from("engagement_orders")
      .select("id,status,order_number,link")
      .eq("user_id", userId)
      .eq("order_number", n)
      .maybeSingle();

    if (findErr) {
      return cancelErr({
        title: "Lookup failed",
        problem: findErr.message,
        fix: "Try again in a few seconds. If it persists, contact support.",
      });
    }
    if (!match) {
      return cancelErr({
        title: "Order not found",
        problem: `No order <code>#${n}</code> found in your account.`,
        fix: "Check the ID with <code>/orders</code> and try again.",
        example: "/cancel 123",
      });
    }
    if (!["pending", "processing", "paused"].includes(match.status)) {
      return cancelErr({
        icon: "⚠️",
        title: "Cannot cancel this order",
        problem: `Order <code>#${n}</code> is already <b>${match.status}</b>.`,
        fix: "Only <b>pending</b>, <b>processing</b>, or <b>paused</b> orders can be cancelled.",
      });
    }

    // 1. Flip parent order first so backend workers stop dispatching
    const { error: oErr } = await supabase
      .from("engagement_orders")
      .update({ status: "cancelled" })
      .eq("id", match.id)
      .neq("status", "cancelled");
    if (oErr) {
      return cancelErr({
        title: "Cancel failed",
        problem: oErr.message,
        fix: "Order status was not changed. Try again shortly.",
      });
    }

    // 2. Cancel non-final items
    const { data: items, error: iErr } = await supabase
      .from("engagement_order_items")
      .update({ status: "cancelled" })
      .eq("engagement_order_id", match.id)
      .not("status", "in", '("completed","cancelled","failed")')
      .select("id");
    if (iErr) {
      return cancelErr({
        icon: "⚠️",
        title: "Partial cancel",
        problem: `Order marked cancelled, but items update failed: ${iErr.message}`,
        fix: "Runs may still process. Contact support to force-stop.",
      });
    }

    // 3. Cancel non-final runs
    let runsCancelled = 0;
    const itemIds = (items ?? []).map((i: any) => i.id);
    if (itemIds.length > 0) {
      const { data: runs, error: rErr } = await supabase
        .from("organic_run_schedule")
        .update({ status: "cancelled", error_message: "Cancelled via Telegram bot", completed_at: new Date().toISOString() })
        .in("engagement_order_item_id", itemIds)
        .not("status", "in", '("completed","cancelled","failed")')
        .select("id");
      if (rErr) {
        return cancelErr({
          icon: "⚠️",
          title: "Partial cancel",
          problem: `Order and items cancelled, but pending runs update failed: ${rErr.message}`,
          fix: "Some scheduled runs may still fire. Contact support if you see new activity.",
        });
      }
      runsCancelled = runs?.length ?? 0;
    }

    // 4. Verify final status to confirm accurate update
    const { data: verify } = await supabase
      .from("engagement_orders")
      .select("status")
      .eq("id", match.id)
      .maybeSingle();

    if (verify?.status !== "cancelled") {
      return cancelErr({
        icon: "⚠️",
        title: "Cancel not confirmed",
        problem: `Expected status <b>cancelled</b>, got <b>${verify?.status ?? "unknown"}</b>.`,
        fix: "Retry <code>/cancel</code> or contact support.",
      });
    }

    return reply(
      chatId,
      [
        `✅ <b>Order #${n} cancelled</b>`,
        `• <b>Status:</b> cancelled (confirmed)`,
        `• <b>Items stopped:</b> ${itemIds.length}`,
        `• <b>Runs stopped:</b> ${runsCancelled}`,
        `• <b>Post:</b> <a href="${match.link}">view</a>`,
        `• <b>Refund:</b> user cancellations are non-refundable`,
      ].join("\n"),
    );
  }


  return reply(chatId, "Unknown command. Send /help.");
}

async function handleCallback(cq: any) {
  const chatId = cq.message?.chat?.id;
  const data = String(cq.data ?? "");
  if (!chatId) return;
  await tg("answerCallbackQuery", { callback_query_id: cq.id });

  const userId = await getLinkedUser(chatId);
  if (!userId) { await reply(chatId, "🔒 Not linked."); return; }

  // apply:<shortcode>:all → apply preset to that post
  if (data.startsWith("apply:")) {
    const [, shortcode] = data.split(":");
    const media = await findMediaByShortcode(userId, shortcode);
    if (!media) { await reply(chatId, "Post not found in your account."); return; }
    const { data: preset } = await supabase.from("engagement_presets").select("*").eq("user_id", userId).maybeSingle();
    const pQty: QtyMap = {
      views: Math.max(0, Math.floor(Number((preset as any)?.views) || 0)),
      likes: Math.max(0, Math.floor(Number((preset as any)?.likes) || 0)),
      comments: Math.max(0, Math.floor(Number((preset as any)?.comments) || 0)),
      saves: Math.max(0, Math.floor(Number((preset as any)?.saves) || 0)),
      shares: Math.max(0, Math.floor(Number((preset as any)?.shares) || 0)),
      reposts: Math.max(0, Math.floor(Number((preset as any)?.reposts) || 0)),
    };
    if (!preset || sumQty(pQty) === 0) {
      await reply(chatId, "No preset. Set with <code>/setdefault V L C [SV SH RP] [DRIP]</code>");
      return;
    }
    const r = await placeEngagement(userId, media.permalink, pQty, Number((preset as any).drip_minutes) || 0);
    if (!r.ok) { await reply(chatId, `❌ ${r.error ?? "Order failed"}`); return; }
    await reply(chatId, `✅ Order <code>#${r.order_number}</code> placed on ${shortcode}\nCharged: ₹${r.charged_inr}`);

    return;
  }

  // post:<shortcode> → hint custom command
  if (data.startsWith("post:")) {
    const [, shortcode] = data.split(":");
    const media = await findMediaByShortcode(userId, shortcode);
    if (!media) { await reply(chatId, "Post not found."); return; }
    await reply(chatId, `Send: <code>/order ${media.permalink} VIEWS LIKES COMMENTS</code>`);
    return;
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  try {
    const update = await req.json();
    const configuredAdminChatId = Deno.env.get("TELEGRAM_CHAT_ID")?.trim();
    const incomingChatId = update.callback_query?.message?.chat?.id
      ?? update.message?.chat?.id
      ?? update.edited_message?.chat?.id;

    // The user-facing bot is paused. Only the configured admin chat can use
    // bot commands or inline callbacks while admin notifications stay active.
    if (!configuredAdminChatId || String(incomingChatId ?? "") !== configuredAdminChatId) {
      console.warn("Ignored Telegram update from non-admin chat");
      return new Response(JSON.stringify({ ok: true, ignored: "admin_only" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (update.callback_query) {
      await handleCallback(update.callback_query);
    } else {
      const msg = update.message ?? update.edited_message;
      if (msg?.chat?.id && msg?.text) await handleCommand(msg.chat.id, msg.from?.username ?? null, msg.text);
    }
  } catch (e) {
    console.error("webhook error", e);
  }
  return new Response(JSON.stringify({ ok: true }), { headers: { "Content-Type": "application/json" } });
});
