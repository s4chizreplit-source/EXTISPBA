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

const ALERT_COOLDOWN_HOURS = 6
const INR_THRESHOLD = 50 // ₹50 — alert if balance falls below this (INR equivalent)

async function getUsdToInrRate(): Promise<number> {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    const j = await r.json()
    const rate = Number(j?.rates?.INR)
    if (rate && rate > 0) return rate
  } catch (e) {
    console.error('FX fetch failed:', (e as Error).message)
  }
  return 84
}

async function sendTelegram(message: string) {
  try {
    const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-telegram-notification`
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')}`,
      },
      body: JSON.stringify({ message, parse_mode: 'HTML' }),
    })
  } catch (e) {
    console.error('TG send error:', e)
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const usdToInr = await getUsdToInrRate()
    console.log(`USD->INR rate: ${usdToInr}`)

    // Optional: check a single account only (much faster for "Check Now" per card)
    let accountId: string | null = null
    let source: 'auto' | 'manual' = 'auto'
    if (req.method === 'POST') {
      try {
        const body = await req.json()
        if (body?.account_id && typeof body.account_id === 'string') {
          accountId = body.account_id
        }
        if (body?.source === 'manual' || body?.account_id) {
          source = 'manual'
        }
      } catch {}
    }

    let query = supabase.from('provider_accounts').select('*').eq('is_active', true)
    if (accountId) query = supabase.from('provider_accounts').select('*').eq('id', accountId)

    const { data: accounts, error } = await query
    if (error) throw error


    const results: any[] = []

    for (const acc of accounts || []) {
      const previousBalance: number | null = acc.balance != null ? Number(acc.balance) : null
      try {
        const formData = new URLSearchParams()
        formData.append('key', acc.api_key)
        formData.append('action', 'balance')

        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 12000)

        const resp = await fetch(acc.api_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: formData.toString(),
          signal: controller.signal,
        })
        clearTimeout(timeoutId)

        const text = await resp.text()
        let data: any
        try { data = JSON.parse(text) } catch { data = { error: text } }

        if (data.error) {
          const errMsg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error)
          await supabase.from('provider_accounts').update({
            balance_checked_at: new Date().toISOString(),
            last_balance_error: errMsg,
          }).eq('id', acc.id)
          await supabase.from('provider_balance_history').insert({
            provider_account_id: acc.id,
            balance: previousBalance,
            balance_currency: acc.balance_currency,
            previous_balance: previousBalance,
            delta: 0,
            status: 'error',
            error_message: errMsg,
            source,
          })
          results.push({ name: acc.name, error: data.error })
          continue
        }

        const balance = parseFloat(data.balance ?? '0')
        const currency = data.currency ?? acc.balance_currency ?? 'USD'
        const delta = previousBalance != null ? balance - previousBalance : 0

        await supabase.from('provider_accounts').update({
          balance,
          balance_currency: currency,
          balance_checked_at: new Date().toISOString(),
          last_balance_error: null,
        }).eq('id', acc.id)

        // Only log meaningful entries: first-ever check, manual check, or actual change.
        const isChange = previousBalance == null || Math.abs(delta) > 0.00005
        if (source === 'manual' || isChange) {
          await supabase.from('provider_balance_history').insert({
            provider_account_id: acc.id,
            balance,
            balance_currency: currency,
            previous_balance: previousBalance,
            delta,
            status: 'ok',
            error_message: null,
            source,
          })
        }

        // Convert to INR for unified threshold comparison
        const isUSD = String(currency).toUpperCase() === 'USD'
        const balanceInr = isUSD ? balance * usdToInr : balance

        const lastAlert = acc.last_low_balance_alert_at ? new Date(acc.last_low_balance_alert_at).getTime() : 0
        const cooldownMs = ALERT_COOLDOWN_HOURS * 60 * 60 * 1000
        const canAlert = Date.now() - lastAlert > cooldownMs
        const isLow = balanceInr < INR_THRESHOLD

        if (isLow && canAlert) {
          const nativeLine = isUSD
            ? `Balance: <b>₹${balanceInr.toFixed(2)}</b> (${balance.toFixed(4)} USD)`
            : `Balance: <b>₹${balanceInr.toFixed(2)}</b>`
          const msg = `⚠️ <b>LOW BALANCE ALERT</b>\n\n` +
            `Provider: <b>${acc.name}</b>\n` +
            `${nativeLine}\n` +
            `Threshold: <b>₹${INR_THRESHOLD}</b>\n\n` +
            `Please top-up soon to avoid order failures.`
          await sendTelegram(msg)
          await supabase.from('provider_accounts').update({
            last_low_balance_alert_at: new Date().toISOString(),
          }).eq('id', acc.id)
        }

        results.push({ name: acc.name, balance, currency, balance_inr: balanceInr.toFixed(2), alerted: isLow && canAlert })
      } catch (e: any) {
        console.error(`Balance check failed for ${acc.name}:`, e.message)
        const errMsg = e.message || 'Network error'
        await supabase.from('provider_accounts').update({
          balance_checked_at: new Date().toISOString(),
          last_balance_error: errMsg,
        }).eq('id', acc.id)
        await supabase.from('provider_balance_history').insert({
          provider_account_id: acc.id,
          balance: previousBalance,
          balance_currency: acc.balance_currency,
          previous_balance: previousBalance,
          delta: 0,
          status: 'error',
          error_message: errMsg,
          source,
        })
        results.push({ name: acc.name, error: errMsg })
      }
    }


    return new Response(JSON.stringify({ success: true, checked: results.length, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})