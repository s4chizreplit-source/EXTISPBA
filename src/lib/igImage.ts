const SUPABASE_URL =
  (import.meta as any).env?.VITE_SUPABASE_URL?.replace(/\/$/, "") || "";

/**
 * Build a proxied Instagram image/thumbnail URL that works on any backend host.
 * `fallback` lets the proxy re-resolve a fresh image when the stored CDN link
 * has expired: pass the post shortcode for media, or `@username` for avatars.
 */
export function igImageUrl(
  url?: string | null,
  fallback?: { code?: string | null; username?: string | null },
): string | undefined {
  const code = fallback?.code ?? undefined;
  const username = fallback?.username ?? undefined;
  if (!url && !code && !username) return undefined;
  if (!SUPABASE_URL) return url ?? undefined;

  const qs = new URLSearchParams();
  if (url) qs.set("url", url);
  if (code) qs.set("code", code);
  if (username) qs.set("user", username);
  return `${SUPABASE_URL}/functions/v1/ig-image-proxy?${qs.toString()}`;
}
