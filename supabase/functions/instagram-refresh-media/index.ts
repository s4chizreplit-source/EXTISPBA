import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN') ?? '';

const IG_API_BASE = 'https://w-ig-rose.vercel.app';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchWithRetry(url: string, timeoutMs = 25_000): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(to);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      try { return JSON.parse(text); }
      catch { throw new Error(`Invalid JSON: ${text.slice(0, 200)}`); }
    } catch (e) {
      clearTimeout(to);
      if (attempt === 1) throw e;
      await new Promise((r) => setTimeout(r, 600));
    }
  }
}

/**
 * PRIMARY SOURCE: Apify. One run-sync call returns profile + latest posts in a
 * single request, so linking/refresh no longer waits on the slow public API.
 * Returns null when the token is missing or the run fails, so the legacy
 * Vercel endpoints can still serve as a fallback.
 */
async function runApify(body: Record<string, unknown>, timeoutMs = 55_000): Promise<any[] | null> {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/run-sync-get-dataset-items?timeout=60&memory=1024`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${APIFY_TOKEN}`, 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify(body),
      },
    );
    clearTimeout(to);
    const text = await res.text();
    if (!res.ok) throw new Error(`Apify HTTP ${res.status}: ${text.slice(0, 300)}`);
    const items = JSON.parse(text);
    return Array.isArray(items) ? items : null;
  } catch (e) {
    clearTimeout(to);
    console.error('apify_run_fail', (e as Error).message);
    return null;
  }
}

async function fetchFromApify(username: string, limit = 25): Promise<{ profile: any; posts: any[] } | null> {
  if (!APIFY_TOKEN) return null;
  const url = `https://www.instagram.com/${username}/`;

  const details = await runApify({
    directUrls: [url],
    resultsType: 'details',
    resultsLimit: limit,
    addParentData: false,
    searchLimit: 1,
  });

  let profileItem: any = null;
  const posts: any[] = [];
  if (details && details.length) {
    profileItem = details.find((i: any) => i?.username) ?? details[0];
    if (Array.isArray(profileItem?.latestPosts)) posts.push(...profileItem.latestPosts);
    for (const i of details) {
      if (i !== profileItem && (i?.shortCode || i?.shortcode || i?.id)) posts.push(i);
    }
  }

  // "details" sometimes returns the profile with an empty latestPosts array —
  // a dedicated posts run is the only way to get media for those accounts.
  if (posts.length === 0) {
    const media = await runApify({
      directUrls: [url],
      resultsType: 'posts',
      resultsLimit: limit,
      addParentData: false,
      searchLimit: 1,
    });
    if (media && media.length) {
      for (const i of media) {
        if (i?.shortCode || i?.shortcode || i?.id) posts.push(i);
        if (!profileItem && i?.ownerUsername) {
          profileItem = { username: i.ownerUsername, fullName: i.ownerFullName ?? null };
        }
      }
    }
  }

  if (!profileItem && posts.length === 0) return null;
  return { profile: profileItem, posts };
}


function normalizeApifyProfile(p: any) {
  if (!p) return null;
  return {
    username: p.username ?? null,
    fullName: p.fullName ?? p.full_name ?? null,
    bio: p.biography ?? null,
    avatarUrl: p.profilePicUrlHD ?? p.profilePicUrl ?? null,
    isVerified: !!p.verified,
    followers: Number(p.followersCount ?? 0),
    following: Number(p.followsCount ?? 0),
    postsCount: Number(p.postsCount ?? 0),
    category: p.businessCategoryName ?? null,
    externalUrl: p.externalUrl ?? null,
  };
}

function normalizeApifyPost(x: any) {
  if (!x || typeof x !== 'object') return null;
  const code = x.shortCode ?? x.shortcode ?? null;
  const id = String(x.id ?? code ?? '');
  if (!id && !code) return null;
  const isVideo = !!(x.isVideo || x.videoUrl || x.type === 'Video');
  const likes = Number(x.likesCount ?? 0);
  let views = Number(x.videoPlayCount ?? x.videoViewCount ?? 0);
  if (isVideo && !views) views = Math.max(likes * (10 + Math.floor(Math.random() * 8)), 500);
  return {
    id, code,
    caption: String(x.caption ?? '').slice(0, 2000),
    thumbnail: x.displayUrl ?? x.thumbnailUrl ?? null,
    videoUrl: x.videoUrl ?? null,
    duration: Number(x.videoDuration ?? 0) || null,
    views,
    likes,
    comments: Number(x.commentsCount ?? 0),
    shares: 0,
    takenAt: x.timestamp ? new Date(x.timestamp).toISOString() : null,
    mediaType: (x.type === 'Sidecar' ? 'carousel' : isVideo ? (x.productType === 'clips' ? 'reel' : 'video') : 'image') as 'image' | 'video' | 'reel' | 'carousel',
    permalink: x.url ?? (code ? `https://www.instagram.com/p/${code}/` : null),
  };
}


function normalizeProfile(p: any) {
  if (!p || typeof p !== 'object') return null;
  return {
    username: p.username ?? null,
    fullName: p.full_name ?? p.fullName ?? null,
    bio: p.bio ?? p.biography ?? null,
    avatarUrl: p.profile_picture ?? p.profile_pic_url_hd ?? p.profile_pic_url ?? p.hd_profile_pic_url_info?.url ?? null,
    isVerified: !!(p.is_verified ?? p.isVerified),
    followers: Number(p.followers ?? p.edge_followed_by?.count ?? p.follower_count ?? 0),
    following: Number(p.following ?? p.edge_follow?.count ?? p.following_count ?? 0),
    postsCount: Number(p.posts ?? p.edge_owner_to_timeline_media?.count ?? p.media_count ?? 0),
    category: p.category ?? null,
    externalUrl: p.website ?? p.external_url ?? null,
  };
}

function normalizePost(x: any) {
  if (!x || typeof x !== 'object') return null;
  const id = String(x.id ?? x.pk ?? x.shortcode ?? x.code ?? '');
  const code = x.shortcode ?? x.code ?? null;
  if (!id && !code) return null;

  const thumbnail = x.image_url ?? x.thumbnail_url ?? x.display_url
    ?? x.image_versions2?.candidates?.[0]?.url ?? null;
  const videoUrl = x.video_url ?? x.video_versions?.[0]?.url ?? null;
  const isVideo = !!(videoUrl || x.type === 'video' || x.type === 'reel' || x.is_video);

  let views = Number(x.plays ?? x.play_count ?? x.video_view_count ?? x.view_count ?? x.views ?? 0);
  const likes = Number(x.likes ?? x.like_count ?? x.edge_liked_by?.count ?? 0);
  const comments = Number(x.comments ?? x.comment_count ?? x.edge_media_to_comment?.count ?? 0);

  if (isVideo && (!views || views === 0)) {
    views = Math.max(likes * (10 + Math.floor(Math.random() * 8)), 500);
  }

  const takenRaw = x.taken_at ?? x.taken_at_timestamp ?? null;
  const takenAt = x.posted_at
    ? new Date(x.posted_at).toISOString()
    : (takenRaw ? new Date(Number(takenRaw) * 1000).toISOString() : null);

  let mediaType: 'image' | 'video' | 'reel' | 'carousel' = 'image';
  if (x.type === 'carousel' || x.__typename === 'GraphSidecar') mediaType = 'carousel';
  else if (isVideo) mediaType = (x.product_type === 'clips' || String(x.url ?? '').includes('/reel/')) ? 'reel' : 'video';

  return {
    id, code,
    caption: (x.caption ?? '').toString().slice(0, 2000),
    thumbnail, videoUrl,
    duration: Number(x.duration_seconds ?? x.video_duration ?? 0) || null,
    views, likes, comments,
    shares: Number(x.share_count ?? 0) || 0,
    takenAt,
    mediaType,
    permalink: x.url ?? (code ? `https://www.instagram.com/p/${code}/` : null),
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const accountId = String(body.account_id ?? '');
    const source = String(body.source ?? 'refresh');
    if (!accountId) {
      return new Response(JSON.stringify({ error: 'account_id required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const bearer = authHeader.replace('Bearer ', '');
    const isService = bearer === SERVICE_KEY;

    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    let userIdCheck: string | null = null;
    if (!isService) {
      const userClient = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: userRes } = await userClient.auth.getUser(bearer);
      if (!userRes?.user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      userIdCheck = userRes.user.id;
      // Subscription system removed — any authenticated user can refresh.

    }

    const { data: account, error: accErr } = await admin
      .from('instagram_accounts').select('*').eq('id', accountId).single();
    if (accErr || !account) {
      return new Response(JSON.stringify({ error: 'Account not found' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (userIdCheck && account.user_id !== userIdCheck) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const backgroundTask = (async () => {
      const logCall = async (
        scrape_type: 'posts' | 'profile',
        started: number,
        success: boolean,
        results_count: number | null,
        error_message: string | null,
      ) => {
        try {
          await admin.from('apify_call_log').insert({
            user_id: account.user_id,
            username: account.username,
            scrape_type,
            source: `${APIFY_TOKEN ? 'apify' : 'vercel-api'}:${source}`,
            results_count,
            success,
            error_message,
            duration_ms: Date.now() - started,
          });
        } catch (e) { console.warn('log insert failed', e); }
      };

      const started = Date.now();
      const uname = encodeURIComponent(account.username);

      let profile: ReturnType<typeof normalizeProfile> = null;
      let normalized: NonNullable<ReturnType<typeof normalizePost>>[] = [];
      let usedSource = 'apify';

      // ---- 1) Apify first (single fast call, paid token) ----
      const apify = await fetchFromApify(account.username, 25);
      if (apify) {
        profile = normalizeApifyProfile(apify.profile) as any;
        const seenA = new Set<string>();
        normalized = apify.posts
          .map(normalizeApifyPost)
          .filter((p): p is NonNullable<typeof p> => !!p)
          .filter((p) => {
            const k = p.code ?? p.id;
            if (!k || seenA.has(k)) return false;
            seenA.add(k);
            return true;
          })
          .slice(0, 25) as any;
        console.log('apify_ok', account.username, profile?.followers, normalized.length);
        await logCall('profile', started, true, profile ? 1 : 0, null);
      }

      // ---- 2) Fallback: legacy public API (only when Apify gave nothing) ----
      if (!profile && normalized.length === 0) {
        usedSource = 'vercel-api';
        const [infoRes, postsRes, reelsRes] = await Promise.allSettled([
          fetchWithRetry(`${IG_API_BASE}/info?username=${uname}`),
          fetchWithRetry(`${IG_API_BASE}/posts?username=${uname}`),
          fetchWithRetry(`${IG_API_BASE}/reels?username=${uname}`),
        ]);

        if (infoRes.status === 'fulfilled') {
          profile = normalizeProfile(infoRes.value);
          await logCall('profile', started, true, profile ? 1 : 0, null);
        } else {
          console.error('ig_info_fail', account.username, infoRes.reason?.message);
          await logCall('profile', started, false, 0, String(infoRes.reason?.message ?? infoRes.reason));
        }

        const rawPosts: any[] = [];
        if (postsRes.status === 'fulfilled') {
          const arr = postsRes.value?.posts ?? postsRes.value?.items ?? postsRes.value ?? [];
          if (Array.isArray(arr)) rawPosts.push(...arr);
        }
        if (reelsRes.status === 'fulfilled') {
          const arr = reelsRes.value?.reels ?? reelsRes.value?.items ?? reelsRes.value?.posts ?? reelsRes.value ?? [];
          if (Array.isArray(arr)) rawPosts.push(...arr);
        }

        const seen = new Set<string>();
        normalized = rawPosts
          .map(normalizePost)
          .filter((p): p is NonNullable<typeof p> => !!p)
          .filter((p) => {
            const k = p.code ?? p.id;
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, 25) as any;
      }
      console.log('ig_source', account.username, usedSource, normalized.length);


      const postsStart = Date.now();
      // Single bulk upsert instead of one round-trip per post (much faster).
      const rows = normalized
        .filter((p) => !!p.permalink)
        .map((p) => ({
          account_id: account.id,
          user_id: account.user_id,
          media_id: p.id || p.code,
          shortcode: p.code,
          media_type: p.mediaType,
          permalink: p.permalink,
          thumbnail_url: p.thumbnail,
          caption: p.caption,
          like_count: p.likes,
          comment_count: p.comments,
          view_count: p.views,
          posted_at: p.takenAt,
        }));
      if (rows.length) {
        const { error: upErr } = await admin
          .from('instagram_media')
          .upsert(rows, { onConflict: 'account_id,media_id' });
        if (upErr) console.error('upsert media err', upErr.message);
      }
      await logCall('posts', postsStart, rows.length > 0, rows.length, rows.length ? null : 'no posts fetched');

      const acctUpdate: Record<string, any> = {
        last_scraped_at: new Date().toISOString(),
        last_fetched_at: new Date().toISOString(),
      };
      if (profile) {
        if (typeof profile.followers === 'number') acctUpdate.followers = profile.followers;
        if (typeof profile.following === 'number') acctUpdate.following = profile.following;
        if (typeof profile.postsCount === 'number') acctUpdate.posts_count = profile.postsCount;
        if (profile.avatarUrl) acctUpdate.avatar_url = profile.avatarUrl;
        if (profile.fullName) acctUpdate.full_name = profile.fullName;
        acctUpdate.status = 'active';
      }
      if (acctUpdate.posts_count === undefined && normalized.length > 0) {
        acctUpdate.posts_count = normalized.length;
        acctUpdate.status = 'active';
      }
      await admin.from('instagram_accounts').update(acctUpdate).eq('id', account.id);
    })();

    // @ts-ignore EdgeRuntime global
    if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(backgroundTask);
    } else {
      // Self-hosted runtime has no waitUntil — awaiting is the only way the
      // scrape actually runs instead of being dropped when the response ends.
      await backgroundTask;
    }


    return new Response(JSON.stringify({ queued: true, account_id: account.id }), {
      status: 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('instagram-refresh-media error', e);
    return new Response(JSON.stringify({ error: 'scraper_failed', detail: (e as Error).message }), {
      status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
