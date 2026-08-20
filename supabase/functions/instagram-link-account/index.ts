import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// NOTE: Apify is intentionally NOT called from this function. Only
// instagram-refresh-media hits Apify. Linking always uses cached DB data
// or creates a placeholder row.
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  try {
    // (Apify token not needed here — link never calls Apify.)

    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (!token) {
      return new Response(JSON.stringify({ error: 'Missing Authorization token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // Verify token via service-role admin client (avoids stale anon key issues)
    const adminAuthClient = createClient(SUPABASE_URL, SERVICE_KEY);
    const { data: userRes, error: userErr } = await adminAuthClient.auth.getUser(token);
    if (userErr || !userRes?.user) {
      console.error('auth.getUser failed', userErr?.message);
      return new Response(JSON.stringify({ error: `Auth verification failed: ${userErr?.message ?? 'no user'}` }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const userId = userRes.user.id;

    // Subscription system removed — any authenticated user can link accounts.


    const body = await req.json().catch(() => ({}));
    let username = String(body.username ?? '').trim().replace(/^@/, '').replace(/\/$/, '');
    if (!username || !/^[A-Za-z0-9._]{1,30}$/.test(username)) {
      return new Response(JSON.stringify({ error: 'Invalid username' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Monthly link cap: max 5 distinct Instagram accounts per rolling 30 days (non-admins).
    // Re-linking an already-linked username does not count (it's a refresh).
    if (!roleRow) {
      const usernameLower = username.toLowerCase();
      const { data: existing } = await adminAuth
        .from('instagram_accounts').select('id').eq('user_id', userId).eq('username', usernameLower).maybeSingle();
      if (!existing) {
        const windowMs = 30 * 24 * 60 * 60 * 1000;
        const sinceDate = new Date(Date.now() - windowMs);
        // Count from the persistent audit log (instagram_link_events) so deleting
        // an account does NOT free up a slot — the 30-day cap is consistent
        // across devices and across delete/re-add cycles.
        const { data: recent } = await adminAuth
          .from('instagram_link_events')
          .select('username, created_at')
          .eq('user_id', userId)
          .eq('event_type', 'link')
          .gte('created_at', sinceDate.toISOString())
          .order('created_at', { ascending: true });
        const used = recent?.length ?? 0;
        const LIMIT = 5;
        if (used >= LIMIT) {
          const oldest = recent![0];
          const resetAt = new Date(new Date(oldest.created_at).getTime() + windowMs);
          const secsUntilReset = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
          const resetHuman = resetAt.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });
          return new Response(JSON.stringify({
            error: `Monthly limit reached: you can link ${LIMIT} Instagram accounts per 30 days. You have used ${used}/${LIMIT}. Next slot frees on ${resetHuman} (when @${oldest.username} rolls out of the window). Remove an existing account to free a slot immediately.`,
            code: 'monthly_link_limit_reached',
            limit: LIMIT,
            used,
            remaining: 0,
            window_days: 30,
            reset_at: resetAt.toISOString(),
            reset_at_human: resetHuman,
            retry_after_seconds: secsUntilReset,
            oldest_linked_username: oldest.username,
            oldest_linked_at: oldest.created_at,
          }), {
            status: 429,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json',
              'Retry-After': String(secsUntilReset),
            },
          });
        }
      }
    }

    // STRICT USERNAME-LEVEL DEDUPE
    // 1. Same user already has this username → return cached row, no Apify.
    // 2. Any OTHER user has scraped this username before → clone their cached
    //    profile fields into a new row for this user, no Apify.
    // Only the very first ever link of a brand-new username triggers a scrape.
    // Explicit refreshes must go through instagram-refresh-media.
    {
      const usernameLower = username.toLowerCase();
      const { data: cached } = await adminAuth
        .from('instagram_accounts')
        .select('*')
        .eq('user_id', userId)
        .eq('username', usernameLower)
        .maybeSingle();
      if (cached) {
        await adminAuth.from('instagram_link_events').insert({
          user_id: userId, username: usernameLower, event_type: 'cache_hit',
        });
        return new Response(JSON.stringify({ account: cached, imported: 0, importing: false, cached: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      // Global dedupe: reuse the most-recently-scraped row for this username
      // from any user in the system.
      const { data: globalCached } = await adminAuth
        .from('instagram_accounts')
        .select('*')
        .eq('username', usernameLower)
        .order('last_scraped_at', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();

      if (globalCached) {
        const admin = createClient(SUPABASE_URL, SERVICE_KEY);
        const clonePayload = {
          user_id: userId,
          username: usernameLower,
          ig_user_id: globalCached.ig_user_id,
          full_name: globalCached.full_name,
          avatar_url: globalCached.avatar_url,
          followers: globalCached.followers,
          following: globalCached.following,
          posts_count: globalCached.posts_count,
          is_private: globalCached.is_private,
          is_verified: globalCached.is_verified,
          biography: globalCached.biography,
          status: 'active',
          last_scraped_at: globalCached.last_scraped_at,
          last_fetched_at: globalCached.last_fetched_at,
        };
        const { data: cloned, error: cloneErr } = await admin
          .from('instagram_accounts')
          .upsert(clonePayload, { onConflict: 'user_id,username' })
          .select()
          .single();
        if (cloneErr) throw cloneErr;

        // Count this as a real link (30-day cap) since a new row was created for this user.
        await admin.from('instagram_link_events').insert({
          user_id: userId, username: usernameLower, event_type: 'link',
        });

        return new Response(JSON.stringify({
          account: cloned, imported: 0, importing: false, cached: true, source: 'global',
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }




    // NO GLOBAL CACHE HIT → create a placeholder row. Apify is NEVER called
    // from this endpoint. User must explicitly click "Refresh" (which calls
    // instagram-refresh-media) to fetch profile + posts from Apify.
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
    const placeholderPayload = {
      user_id: userId,
      username: username.toLowerCase(),
      ig_user_id: null,
      full_name: null,
      avatar_url: null,
      followers: 0,
      following: 0,
      posts_count: 0,
      is_private: false,
      is_verified: false,
      biography: null,
      status: 'pending_refresh',
    };
    const { data: account, error: accErr } = await admin
      .from('instagram_accounts')
      .upsert(placeholderPayload, { onConflict: 'user_id,username' })
      .select()
      .single();
    if (accErr) throw accErr;

    // Persistent audit log: this counts against the 30-day link limit.
    await admin.from('instagram_link_events').insert({
      user_id: userId, username: account.username, event_type: 'link',
    });

    // Kick off the Apify scrape right away (fire-and-forget) so the user does
    // not have to press Refresh manually — the row fills in within seconds.
    try {
      fetch(`${SUPABASE_URL}/functions/v1/instagram-refresh-media`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: account.id, source: 'auto-link' }),
      }).catch((e) => console.warn('auto refresh trigger failed', (e as Error).message));
    } catch (e) { console.warn('auto refresh trigger error', (e as Error).message); }

    return new Response(JSON.stringify({
      account,
      imported: 0,
      importing: true,
      cached: false,
      pending_refresh: true,
      message: 'Account linked. Fetching profile + posts…',
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });



  } catch (e) {
    console.error('instagram-link-account error', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
