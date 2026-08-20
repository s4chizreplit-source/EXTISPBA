// Instagram CDN image proxy — bypasses hotlink protection AND recovers from
// expired CDN links (Instagram/Apify image URLs die after a few hours).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

const ALLOWED = /^https:\/\/[^/]*(cdninstagram|fbcdn|instagram\.com|apify|unavatar\.io)[^/]*\//i;

async function tryFetch(target: string): Promise<Response | null> {
  try {
    const res = await fetch(target, {
      redirect: "follow",
      headers: {
        "User-Agent": UA,
        Referer: "https://www.instagram.com/",
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    return res;
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = new URL(req.url);
    const rawTarget = url.searchParams.get("url");
    const code = url.searchParams.get("code");
    const user = url.searchParams.get("user");

    // Candidate list: stored URL first, then live re-resolvers that never expire.
    const candidates: string[] = [];
    if (rawTarget) {
      const decoded = decodeURIComponent(rawTarget);
      if (ALLOWED.test(decoded)) candidates.push(decoded);
    }
    if (code) {
      candidates.push(`https://www.instagram.com/p/${encodeURIComponent(code)}/media/?size=l`);
      candidates.push(`https://www.instagram.com/p/${encodeURIComponent(code)}/media/?size=m`);
    }
    if (user) {
      candidates.push(`https://unavatar.io/instagram/${encodeURIComponent(user.replace(/^@/, ""))}`);
    }

    if (candidates.length === 0) {
      return new Response("Missing url", { status: 400, headers: corsHeaders });
    }

    for (const candidate of candidates) {
      const upstream = await tryFetch(candidate);
      if (upstream) {
        return new Response(upstream.body, {
          status: 200,
          headers: {
            ...corsHeaders,
            "Content-Type": upstream.headers.get("content-type") ?? "image/jpeg",
            "Cache-Control": "public, max-age=86400, s-maxage=86400",
          },
        });
      }
    }

    return new Response("Upstream unavailable", { status: 502, headers: corsHeaders });
  } catch (e) {
    return new Response(`Error: ${(e as Error).message}`, { status: 500, headers: corsHeaders });
  }
});
