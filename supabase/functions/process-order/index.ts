import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

// Errors where we should try the NEXT provider account
const TRY_NEXT_ERRORS = [
  'active order with this link',
  'wait until order being completed',
  'already has an order',
  'order in progress',
  'link currently active',
  'processing previous order',
  'wait for completion',
  'processing another transaction',
  'balance',
  'not have enough',
  'invalid api key',
  'api key not found',
  'unauthorized',
  'quantity less than minimal',
  'quantity less than minimum',
  'min quantity',
  'service not found',
  'incorrect service',
  'invalid service',
  'service unavailable',
  'service is not available',
  'disabled',
  'maintenance',
  'rate limit',
  'timeout',
  'temporarily',
  'too many requests',
]

function shouldTryNextProvider(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase()
  return TRY_NEXT_ERRORS.some(e => lower.includes(e))
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    let isServiceRole = false;
    let authenticatedUserId: string | null = null;
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }
    const token = authHeader.replace('Bearer ', '')
    
    if (token === Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      isServiceRole = true;
    } else {
      const { data: { user }, error: verifyError } = await supabase.auth.getUser(token)
      if (verifyError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
      authenticatedUserId = user.id;
    }

    const { order_id } = await req.json()

    const { data: order, error: orderError } = await supabase.from('orders').select('*, service:services(*)').eq('id', order_id).single()
    if (orderError || !order) return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

    // Ownership check for non-service-role callers (admin allowed)
    if (!isServiceRole && authenticatedUserId && order.user_id !== authenticatedUserId) {
      const { data: roleRow } = await supabase
        .from('user_roles').select('role').eq('user_id', authenticatedUserId).eq('role', 'admin').maybeSingle()
      if (!roleRow) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    const currentOrderError = (order.error_message || '').toLowerCase()
    const hasUncertainDispatch = currentOrderError.includes('[dispatch uncertain]') || currentOrderError.includes('[awaiting provider confirmation]')

    if (order.provider_order_id) {
      return new Response(JSON.stringify({ success: true, provider_order_id: order.provider_order_id, skipped: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (hasUncertainDispatch) {
      return new Response(JSON.stringify({ success: false, skipped: true, error: 'Order dispatch is awaiting provider confirmation to avoid duplicate placement' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!['pending', 'failed'].includes(order.status || 'pending')) {
      return new Response(JSON.stringify({ success: true, skipped: true, status: order.status }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // CRITICAL: Skip direct API call for organic orders
    if (order.is_organic_mode) {
      console.log(`[process-order] Organic order ${order_id} detected, skips direct API call (handled by schedule)`)
      return new Response(JSON.stringify({ 
        success: true, 
        message: 'Organic order detected, delivery will follow schedule',
        is_organic: true 
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // ========== MULTI-PROVIDER ROTATION ==========
    // 1. Try service_provider_mapping first (multiple accounts)
    // 2. Fall back to legacy provider if no mappings exist
    
    const serviceId = order.service_id
    const providerId = order.service?.provider_id
    
    // Get all active provider account mappings for this service
    const { data: mappings } = await supabase
      .from('service_provider_mapping')
      .select('*, provider_account:provider_accounts(*)')
      .eq('service_id', serviceId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true })

    // Build list of providers to try
    interface ProviderOption {
      name: string
      apiKey: string
      apiUrl: string
      providerServiceId: string
      accountId?: string
    }
    
    const providerOptions: ProviderOption[] = []

    if (mappings && mappings.length > 0) {
      // Sort by priority, then LRU as tiebreaker
      const sorted = [...mappings].sort((a, b) => {
        const ap = a.sort_order || 0
        const bp = b.sort_order || 0
        if (ap !== bp) return ap - bp
        const at = a.provider_account?.last_used_at ? new Date(a.provider_account.last_used_at).getTime() : 0
        const bt = b.provider_account?.last_used_at ? new Date(b.provider_account.last_used_at).getTime() : 0
        return at - bt
      })

      for (const m of sorted) {
        const acc = m.provider_account
        if (acc && acc.is_active) {
          providerOptions.push({
            name: acc.name,
            apiKey: acc.api_key,
            apiUrl: acc.api_url,
            providerServiceId: m.provider_service_id,
            accountId: acc.id,
          })
        }
      }
    }

    // Fallback: legacy single provider
    if (providerOptions.length === 0 && providerId) {
      const { data: provider } = await supabase.from('providers').select('*').eq('id', providerId).single()
      if (provider) {
        providerOptions.push({
          name: provider.name,
          apiKey: provider.api_key,
          apiUrl: provider.api_url,
          providerServiceId: order.service?.provider_service_id || '',
        })
      }
    }

    if (providerOptions.length === 0) {
      await supabase.from('orders').update({ status: 'failed', error_message: 'No provider available' }).eq('id', order_id)
      return new Response(JSON.stringify({ error: 'No provider available for this service' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const claimTimestamp = new Date().toISOString()
    const { data: claimedOrder, error: claimError } = await supabase
      .from('orders')
      .update({
        status: 'processing',
        error_message: 'Dispatching provider order...',
        updated_at: claimTimestamp,
      })
      .eq('id', order_id)
      .in('status', ['pending', 'failed'])
      .is('provider_order_id', null)
      .select('id')
      .maybeSingle()

    if (claimError) {
      return new Response(JSON.stringify({ error: claimError.message || 'Failed to claim order for processing' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    if (!claimedOrder) {
      return new Response(JSON.stringify({ success: true, skipped: true, message: 'Order already claimed by another execution' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    // Try each provider in order until one succeeds
    let lastError = ''
    
    for (const provider of providerOptions) {
      console.log(`[process-order] Trying provider: ${provider.name}`)
      
      const formData = new URLSearchParams()
      formData.append('key', provider.apiKey)
      formData.append('action', 'add')
      formData.append('service', provider.providerServiceId)
      formData.append('link', order.link)
      formData.append('quantity', order.quantity.toString())

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 15000)
        
        const response = await fetch(provider.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString(),
          signal: controller.signal,
        })
        clearTimeout(timeoutId)

        const responseText = await response.text()
        let result
        try { result = JSON.parse(responseText) } catch { result = { error: responseText } }

        if (result.error) {
          const errorMsg = typeof result.error === 'string' ? result.error : JSON.stringify(result.error)
          console.log(`[process-order] Provider ${provider.name} error: ${errorMsg}`)
          lastError = errorMsg

          // SOFT ERROR -> always move on to the next provider in priority order.
          // Even on the last provider we fall through to the "all providers
          // failed" handler below, never to a hard failure with this text.
          if (shouldTryNextProvider(errorMsg)) {
            console.log(`[process-order] Soft error, trying next provider...`)
            continue
          }

          // HARD ERROR -> fail immediately with the exact provider text.
          await supabase.from('orders').update({ status: 'failed', error_message: errorMsg }).eq('id', order_id)
          return new Response(JSON.stringify({ success: false, error: errorMsg }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }

        // SUCCESS!
        const providerOrderId = result.order?.toString() || result.id?.toString() || 'unknown'
        
        await supabase.from('orders').update({ 
          status: 'processing', 
          provider_order_id: providerOrderId, 
          error_message: null 
        }).eq('id', order_id)

        // Update last_used_at for the account
        if (provider.accountId) {
          await supabase.from('provider_accounts').update({ 
            last_used_at: new Date().toISOString() 
          }).eq('id', provider.accountId)
        }

        console.log(`[process-order] ✅ Success via ${provider.name}, provider order: ${providerOrderId}`)
        return new Response(JSON.stringify({ success: true, provider_order_id: providerOrderId }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        
        } catch (fetchError: any) {
        console.log(`[process-order] Network error with ${provider.name}: ${fetchError.message}`)
        await supabase.from('orders').update({
          status: 'processing',
          error_message: `Network error after provider request. [Dispatch uncertain] Verify provider before retrying: ${fetchError.message}`,
          updated_at: new Date().toISOString(),
        }).eq('id', order_id)

        return new Response(JSON.stringify({ success: false, error: 'Provider dispatch uncertain. Auto-retry blocked to prevent duplicate order.' }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
    }

    // All providers failed
    await supabase.from('orders').update({ status: 'failed', error_message: `All providers failed. Last: ${lastError}` }).eq('id', order_id)
    return new Response(JSON.stringify({ success: false, error: `All providers failed. Last: ${lastError}` }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
      return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})