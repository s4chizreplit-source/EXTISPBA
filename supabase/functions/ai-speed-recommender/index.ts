import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const RATIO_BANDS = {
  likes:    { lowOk: 4,   highOk: 10,  label: "4–10% of views" },
  comments: { lowOk: 0.3, highOk: 1.5, label: "0.3–1.5% of views" },
  shares:   { lowOk: 0.3, highOk: 2,   label: "0.3–2% of views" },
  saves:    { lowOk: 0.3, highOk: 3,   label: "0.3–3% of views" },
};

function detectPlatform(link: string): string {
  const l = (link || "").toLowerCase();
  if (l.includes("instagram.com")) return "instagram";
  if (l.includes("tiktok.com")) return "tiktok";
  if (l.includes("youtube.com") || l.includes("youtu.be")) return "youtube";
  if (l.includes("twitter.com") || l.includes("x.com")) return "twitter";
  if (l.includes("facebook.com") || l.includes("fb.com")) return "facebook";
  if (l.includes("t.me") || l.includes("telegram")) return "telegram";
  return "unknown";
}

function detectPostType(link: string): string {
  const l = (link || "").toLowerCase();
  if (l.includes("/reel/") || l.includes("/reels/")) return "reel";
  if (l.includes("/p/")) return "post";
  if (l.includes("/tv/")) return "igtv";
  if (l.includes("/stories/") || l.includes("/story/")) return "story";
  if (l.includes("/shorts/")) return "short";
  if (l.includes("watch?v=") || l.includes("youtu.be/")) return "video";
  if (l.match(/instagram\.com\/[^/]+\/?$/)) return "profile";
  return "post";
}

function buildRatioSummary(perType: Record<string, number>) {
  const views = perType.views ?? perType.impressions ?? 0;
  const lines: string[] = [];
  const flags: string[] = [];
  if (views > 0) {
    for (const k of Object.keys(RATIO_BANDS) as (keyof typeof RATIO_BANDS)[]) {
      const v = perType[k] ?? 0;
      if (v <= 0) continue;
      const pct = (v / views) * 100;
      const band = RATIO_BANDS[k];
      lines.push(`- ${k}: ${v.toLocaleString()} (${pct.toFixed(2)}% of views, organic = ${band.label})`);
      if (pct < band.lowOk) flags.push(`${k} too low (${pct.toFixed(2)}%) — needs more for organic look`);
      else if (pct > band.highOk) flags.push(`${k} too high (${pct.toFixed(2)}%) — may look botted`);
    }
  }
  return { lines, flags };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const { link = "", platform: platformIn = "", perType = {}, messages, types, totalQuantity } = body || {};

    const key = Deno.env.get("LOVABLE_API_KEY");
    if (!key) {
      return new Response(JSON.stringify({ error: "AI key missing" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const platform = platformIn || detectPlatform(link);
    const postType = detectPostType(link);
    const { lines: ratioLines, flags } = buildRatioSummary(perType || {});

    // ===== CHAT MODE =====
    if (Array.isArray(messages) && messages.length > 0) {
      const systemPrompt = `You are "Organic AI", a friendly social-media growth coach inside an SMM panel. The user is planning an engagement order and may ask you anything about it. ALWAYS reply in English only. Be concise (2–6 short sentences), warm, and concrete with numbers.

You KNOW these organic engagement benchmarks for short-video / Instagram-style content:
- Likes: 4–10% of views (healthy)
- Comments: 0.3–1.5% of views
- Shares: 0.3–2% of views
- Saves: 0.3–3% of views
- Views deliver fastest; comments/saves slowest
- Always recommend natural drip / time-spread, never instant bursts

Order context:
- Link: ${link || "(none yet)"}
- Detected platform: ${platform}
- Detected post type: ${postType}
- Per-type quantities the user has selected:
${ratioLines.length ? ratioLines.join("\n") : "  (none selected yet)"}
${flags.length ? "\nDetected ratio warnings:\n- " + flags.join("\n- ") : ""}

When the user asks "is this safe?", "how long will it take?", "how many likes should I add?", give a clear answer using the numbers above. When suggesting a fix, give exact target quantities (e.g. "With 12,000 views, keep likes around ~700 (≈6%)").`;

      const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [{ role: "system", content: systemPrompt }, ...messages],
        }),
      });

      if (aiRes.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit. Try again in a minute." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiRes.status === 402) {
        return new Response(JSON.stringify({ error: "AI credits exhausted. Contact admin." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!aiRes.ok) {
        const t = await aiRes.text();
        return new Response(JSON.stringify({ error: "AI error", detail: t.slice(0, 200) }), {
          status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const data = await aiRes.json();
      const reply = data?.choices?.[0]?.message?.content || "(no reply)";
      return new Response(JSON.stringify({
        success: true,
        reply,
        platform,
        postType,
        ratioSummary: ratioLines,
        flags,
      }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    // ===== ONE-SHOT RECOMMENDATION (legacy) =====
    if (!link || !types || !totalQuantity) {
      return new Response(JSON.stringify({ error: "Missing fields" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const typeList = Array.isArray(types) ? types.join(", ") : String(types);

    const systemPrompt = `You are an organic social media growth strategist. Recommend the SAFEST organic delivery plan that mimics human behavior. Return STRICT JSON only.

Benchmarks:
- Likes 4–10% of views, Comments 0.3–1.5%, Shares 0.3–2%, Saves 0.3–3%
- Views fastest, comments/saves slowest
- Bigger order = longer window

Output schema: { "delivery_hours": number, "runs": number, "per_type_hours": {...}, "safety_score": number (0-100), "warnings": string[], "explanation": string }`;

    const userPrompt = `Platform: ${platform}
Post type: ${postType}
Post URL: ${link}
Engagement types: ${typeList}
Total target quantity: ${totalQuantity}
${ratioLines.length ? "Per-type counts:\n" + ratioLines.join("\n") : ""}`;

    const aiRes = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return new Response(JSON.stringify({ error: "AI error", detail: t.slice(0, 200) }), {
        status: aiRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await aiRes.json();
    const content = data?.choices?.[0]?.message?.content || "{}";
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(content); } catch { parsed = {}; }
    return new Response(JSON.stringify({
      success: true,
      recommendation: parsed,
      platform,
      postType,
      ratioSummary: ratioLines,
      flags,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
