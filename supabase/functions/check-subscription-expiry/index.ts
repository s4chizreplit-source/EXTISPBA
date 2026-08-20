import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Auth check - allow cron (anon key) or authenticated users
    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Verify token is valid
    const token = authHeader.replace('Bearer ', '');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    if (token !== anonKey && token !== supabaseServiceKey) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token);
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
    }

    console.log('Starting subscription expiry check...');

    // Find all monthly subscriptions that have expired
    const now = new Date().toISOString();
    
    const { data: expiredSubs, error: fetchError } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('plan_type', 'monthly')
      .eq('status', 'active')
      .lt('expires_at', now);

    if (fetchError) {
      console.error('Error fetching expired subscriptions:', fetchError);
      throw fetchError;
    }

    console.log(`Found ${expiredSubs?.length || 0} expired subscriptions`);

    if (expiredSubs && expiredSubs.length > 0) {
      // Update all expired subscriptions to expired status
      const { error: updateError } = await supabase
        .from('subscriptions')
        .update({
          status: 'expired',
          plan_type: 'none',
        })
        .in('id', expiredSubs.map(s => s.id));

      if (updateError) {
        console.error('Error updating subscriptions:', updateError);
        throw updateError;
      }

      console.log(`Expired ${expiredSubs.length} subscriptions`);

      // Log the expired users for debugging
      for (const sub of expiredSubs) {
        console.log(`Expired subscription for user: ${sub.user_id}`);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        expired_count: expiredSubs?.length || 0,
        message: `Checked and expired ${expiredSubs?.length || 0} subscriptions`,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 200,
      }
    );
  } catch (error) {
    console.error('Error in check-subscription-expiry:', error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status: 500,
      }
    );
  }
});
