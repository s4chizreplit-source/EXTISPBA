import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

const PROJECT_ANON_KEY_FALLBACK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2cmJoZ3VseHFkc2FtaGRqemt3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODEyNDYyNDIsImV4cCI6MjA5NjgyMjI0Mn0._I4OukQ6LlNmTxvPp2yvPat-jiYxOaCEZXGxRl9NqeM'

function isProjectAnonJwt(token: string) {
  try {
    const [, payloadPart] = token.split('.')
    if (!payloadPart) return false
    const padded = payloadPart.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payloadPart.length / 4) * 4, '=')
    const payload = JSON.parse(atob(padded))
    const projectRef = new URL(Deno.env.get('SUPABASE_URL') ?? '').hostname.split('.')[0]
    return payload?.iss === 'supabase' && payload?.role === 'anon' && payload?.ref === projectRef
  } catch {
    return false
  }
}

// Module-level client - reused across invocations for connection pooling
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

// This function is called by a cron job every 5 minutes
// WAIT MODE: Only processes next run when previous run is complete
serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Auth check - cron uses service-role; admin users may also invoke
    const authHeader = req.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || PROJECT_ANON_KEY_FALLBACK
    const isSystem = (serviceKey && token === serviceKey) || (cronSecret && token === cronSecret) || (anonKey && token === anonKey) || isProjectAnonJwt(token)
    if (!isSystem) {
      const { data: { user }, error: authError } = await supabase.auth.getUser(token)
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
          status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
      const { data: roleRow } = await supabase
        .from('user_roles').select('role').eq('user_id', user.id).eq('role', 'admin').maybeSingle()
      if (!roleRow) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        })
      }
    }

    const now = new Date().toISOString()
    console.log(`=== EXECUTE ORGANIC RUNS (WAIT MODE) ===`)
    console.log(`Time: ${now}`)

    // Step 1: Get all orders that have organic runs in progress
    // Note: 'paused' and 'cancelled' status orders are NOT included - they are skipped
    const { data: activeOrders, error: ordersError } = await supabase
      .from('orders')
      .select('id, link, service_id, status')
      .in('status', ['pending', 'processing']) // 'paused' and 'cancelled' orders are skipped
      .eq('is_organic_mode', true)

    if (ordersError) {
      console.error('Error fetching active orders:', ordersError)
      return new Response(JSON.stringify({ error: ordersError.message }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    console.log(`Found ${activeOrders?.length || 0} active organic orders`)

    if (!activeOrders || activeOrders.length === 0) {
      return new Response(JSON.stringify({ 
        message: 'No active organic orders', 
        processed: 0 
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    let processed = 0
    let skipped = 0
    let failed = 0
    const results: any[] = []

    // Process each order
    for (const order of activeOrders) {
      console.log(`\n--- Checking Order ${order.id} ---`)

      // Step 2: Check if there's a run currently "started" (in progress with provider)
      const { data: startedRuns } = await supabase
        .from('organic_run_schedule')
        .select('id, run_number, provider_order_id')
        .eq('order_id', order.id)
        .eq('status', 'started')

      if (startedRuns && startedRuns.length > 0) {
        console.log(`Order ${order.id} has run #${startedRuns[0].run_number} in progress with provider`)
        
        // Check with provider if the order is complete
        // For now, we'll mark it as complete after some time (provider should have status check API)
        // TODO: Implement provider status check API
        
        // Skip this order - wait for current run to complete
        skipped++
        results.push({ 
          order_id: order.id, 
          skipped: true, 
          reason: `Run #${startedRuns[0].run_number} still in progress` 
        })
        continue
      }

      // Step 3: Find the next pending run that is due
      const { data: pendingRuns, error: runsError } = await supabase
        .from('organic_run_schedule')
        .select('*')
        .eq('order_id', order.id)
        .eq('status', 'pending')
        .lte('scheduled_at', now)
        .order('run_number', { ascending: true })
        .limit(1)

      if (runsError) {
        console.error(`Error fetching runs for order ${order.id}:`, runsError)
        continue
      }

      if (!pendingRuns || pendingRuns.length === 0) {
        console.log(`No pending runs due for order ${order.id}`)
        continue
      }

      const run = pendingRuns[0]
      const existingRunError = (run.error_message || '').toLowerCase()
      if (run.provider_order_id || existingRunError.includes('[dispatch uncertain]') || existingRunError.includes('[awaiting provider confirmation]')) {
        skipped++
        continue
      }
      console.log(`Processing Run #${run.run_number} for order ${order.id}`)
      console.log(`Quantity: ${run.quantity_to_send}`)

      // Step 4: Get service and provider details
      const { data: orderData } = await supabase
        .from('orders')
        .select('*, service:services(*)')
        .eq('id', order.id)
        .single()

      if (!orderData?.service) {
        console.error('Service not found for order:', order.id)
        await supabase.from('organic_run_schedule').update({
          status: 'failed',
          error_message: 'Service not found'
        }).eq('id', run.id)
        failed++
        continue
      }

      const { data: mapping } = await supabase.from('service_provider_mapping')
        .select('provider_service_id, provider_account:provider_accounts(*)')
        .eq('service_id', orderData.service.id).eq('is_active', true)
        .order('sort_order', { ascending: true }).limit(1).maybeSingle()
      const provider = mapping?.provider_account as any

      if (!provider || !provider.is_active || !provider.api_key?.trim() || !provider.api_url?.trim()) {
        console.error('Active provider mapping/account with API credentials not found for service:', orderData.service.id)
        await supabase.from('organic_run_schedule').update({
          status: 'failed',
          error_message: `No active provider mapping/account for service ${orderData.service.id}`,
          last_status_check: new Date().toISOString()
        }).eq('id', run.id)
        failed++
        continue
      }

      // Step 5: Mark run as started FIRST (prevents duplicate processing)
      const { data: claimedRun, error: updateError } = await supabase
        .from('organic_run_schedule')
        .update({
          status: 'started',
          started_at: new Date().toISOString()
        })
        .eq('id', run.id)
        .eq('status', 'pending')
        .is('provider_order_id', null)
        .select('id')
        .maybeSingle()

      if (updateError) {
        console.log(`Run ${run.id} already being processed, skipping`)
        continue
      }

      if (!claimedRun) {
        console.log(`Run ${run.id} already claimed by another execution, skipping duplicate send`)
        skipped++
        continue
      }

      // Update order status to processing
      await supabase.from('orders').update({
        status: 'processing'
      }).eq('id', order.id)

      // Step 6: Send to provider API
      console.log(`Sending to ${provider.name}: ${run.quantity_to_send} items`)
      
      // Respect configured service minimum only
      let quantityToSend = run.quantity_to_send
      const serviceMinQty = Number(orderData.service.min_quantity || 0)
      const effectiveMin = serviceMinQty > 0 ? serviceMinQty : quantityToSend
      if (quantityToSend < effectiveMin) {
        console.log(`📏 Boosting qty from ${quantityToSend} to configured min ${effectiveMin}`)
        quantityToSend = effectiveMin
      }
      
      const formData = new URLSearchParams()
      formData.append('key', provider.api_key)
      formData.append('action', 'add')
      formData.append('service', mapping?.provider_service_id || orderData.service.provider_service_id)
      formData.append('link', orderData.link)
      formData.append('quantity', quantityToSend.toString())

      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 15000) // 15s timeout
        
        const response = await fetch(provider.api_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString(),
          signal: controller.signal,
        })
        
        clearTimeout(timeoutId)

        const responseText = await response.text()
        console.log(`Provider response: HTTP ${response.status} ${responseText}`)

        let result
        try {
          result = JSON.parse(responseText)
        } catch {
          result = { error: responseText }
        }

        if (!response.ok || result.error) {
          const rawError = result.error || responseText || response.statusText
          const errorMsg = `HTTP ${response.status}: ${typeof rawError === 'string' ? rawError : JSON.stringify(rawError)}`
          console.error(`Run ${run.id} failed:`, errorMsg)
          
          await supabase.from('organic_run_schedule').update({
            status: 'failed',
            error_message: errorMsg,
            provider_response: result
          }).eq('id', run.id)
          
          failed++
          results.push({ order_id: order.id, run_id: run.id, run_number: run.run_number, success: false, error: errorMsg })
        } else {
          const providerOrderId = result.order?.toString() || result.id?.toString()
          console.log(`Run ${run.id} sent to provider! Provider Order ID: ${providerOrderId}`)
          
          // Keep status as 'started' - will be marked complete when provider finishes
          // Store provider order ID for status checking
          await supabase.from('organic_run_schedule').update({
            provider_order_id: providerOrderId,
            provider_response: result
          }).eq('id', run.id)
          
          processed++
          results.push({ 
            order_id: order.id, 
            run_id: run.id, 
            run_number: run.run_number, 
            success: true, 
            provider_order_id: providerOrderId,
            status: 'started' // Will be completed after provider check
          })
        }
      } catch (fetchError) {
        console.error(`Network error for run ${run.id}:`, fetchError)
        await supabase.from('organic_run_schedule').update({
          status: 'started',
          error_message: 'Network error after provider request. [Dispatch uncertain] Verify provider before retrying: ' + (((fetchError as Error).message) || 'Unknown'),
          provider_response: {
            uncertain_dispatch: true,
            stage: 'provider_add_request',
            fetch_error: ((fetchError as Error).message) || 'Unknown',
            happened_at: new Date().toISOString(),
          }
        }).eq('id', run.id)
        skipped++
      }

      // Small delay between orders
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    console.log(`\n=== EXECUTION COMPLETE ===`)
    console.log(`Processed: ${processed}, Skipped: ${skipped}, Failed: ${failed}`)

    return new Response(JSON.stringify({
      success: true,
      processed,
      skipped,
      failed,
      results
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    console.error('Execution error:', error)
    return new Response(JSON.stringify({ 
      error: (error as Error).message || 'Internal server error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
