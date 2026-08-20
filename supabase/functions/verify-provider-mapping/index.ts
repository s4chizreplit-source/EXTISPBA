import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const authHeader = req.headers.get('Authorization') || ''
    if (!authHeader.startsWith('Bearer ')) return json({ error: 'Unauthorized' }, 401)
    const token = authHeader.replace('Bearer ', '')

    if (token !== Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')) {
      const { data: { user }, error } = await supabase.auth.getUser(token)
      if (error || !user) return json({ error: 'Unauthorized' }, 401)
      const { data: adminRow } = await supabase
        .from('user_roles').select('role')
        .eq('user_id', user.id).eq('role', 'admin').maybeSingle()
      if (!adminRow) return json({ error: 'Forbidden' }, 403)
    }

    const body = await req.json().catch(() => ({}))
    let providerAccountId: string | undefined = body?.provider_account_id
    let providerServiceId: string | undefined = body?.provider_service_id

    if (body?.mapping_id) {
      const { data: mapping } = await supabase
        .from('service_provider_mapping')
        .select('provider_account_id, provider_service_id')
        .eq('id', body.mapping_id)
        .maybeSingle()
      if (!mapping) return json({ error: 'Mapping not found' }, 404)
      providerAccountId = mapping.provider_account_id ?? undefined
      providerServiceId = mapping.provider_service_id ?? undefined
    }

    if (!providerAccountId || !providerServiceId) {
      return json({ error: 'provider_account_id and provider_service_id are required' }, 400)
    }

    const { data: account } = await supabase
      .from('provider_accounts')
      .select('id, name, api_url, api_key')
      .eq('id', providerAccountId)
      .maybeSingle()
    if (!account) return json({ error: 'Provider account not found' }, 404)

    const form = new URLSearchParams()
    form.append('key', account.api_key)
    form.append('action', 'services')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    let text = ''
    try {
      const resp = await fetch(account.api_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: controller.signal,
      })
      text = await resp.text()
    } catch (e) {
      clearTimeout(timeoutId)
      return json({ verified: false, provider: account.name, error: `Provider unreachable: ${(e as Error).message}` })
    }
    clearTimeout(timeoutId)

    let data: any
    try { data = JSON.parse(text) } catch { data = { error: text.slice(0, 300) } }

    if (!Array.isArray(data)) {
      const err = typeof data?.error === 'string' ? data.error : 'Provider did not return a service list'
      return json({ verified: false, provider: account.name, error: err })
    }

    const match = data.find((s: any) => String(s?.service) === String(providerServiceId))
    if (!match) {
      return json({
        verified: false,
        provider: account.name,
        provider_service_id: providerServiceId,
        error: `Service ID ${providerServiceId} no longer exists on ${account.name}`,
      })
    }

    return json({
      verified: true,
      provider: account.name,
      provider_service_id: providerServiceId,
      service: {
        name: match.name ?? null,
        rate: match.rate ?? null,
        min: match.min ?? null,
        max: match.max ?? null,
        type: match.type ?? null,
      },
    })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
