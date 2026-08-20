import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { assertPaymentEligible } from '../_shared/payment-eligibility.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
}

// ============================================
// SERVICE-SPECIFIC ORGANIC SCHEDULING v7.0
// Each engagement type has UNIQUE delivery patterns
// ============================================

type ServiceCategory =
  | 'views' | 'likes' | 'comments' | 'followers' | 'subscribers'
  | 'retweets' | 'shares' | 'saves' | 'watch_hours' | 'reposts' | 'generic'

interface OrganicServiceConfig {
  baseIntervalMinutes: number
  intervalVariance: number
  quantityVariancePercent: number
  spikeChance: number
  spikeMagnitude: [number, number]
  dipChance: number
  dipMagnitude: [number, number]
  burstChance: number
  pauseChance: number
  patternBreakerChance: number
  peakHourBoost: number
  nightReduction: number
  runsPerThousand: number
  minRunsPerOrder: number
  maxRunsPerOrder: number
  targetHumanScore: [number, number]
  defaultMinQty: number
}

interface ScheduledRunInput {
  run_number?: number
  scheduled_at: string
  quantity_to_send: number
  base_quantity?: number
  variance_applied?: number
  peak_multiplier?: number
}

// Fully organic randomizer: no repeated quantity, no repeated gap between runs
function uniquifyScheduledRuns(
  runs: ScheduledRunInput[],
  totalTargetQty: number,
  providerMin: number,
  maxBatchCap: number
) {
  const base = runs
    .map((run, index) => ({
      run_number: index + 1,
      at: new Date(run.scheduled_at).getTime(),
      quantity_to_send: Math.max(0, Math.round(Number(run.quantity_to_send) || 0)),
      base_quantity: Math.max(0, Math.round(Number(run.base_quantity ?? run.quantity_to_send) || 0)),
      variance_applied: Number(run.variance_applied ?? 0),
      peak_multiplier: Number(run.peak_multiplier ?? 1),
      status: 'pending'
    }))
    .filter((run) => run.quantity_to_send > 0)
    .sort((a, b) => a.at - b.at)

  if (base.length === 0) return []

  // Never let the cap be smaller than what the preview already asked for
  const previewMax = base.reduce((m, r) => Math.max(m, r.quantity_to_send), 0)
  const cap = Math.max(maxBatchCap, Math.ceil(previewMax * 1.35))
  const floor = Math.max(1, Math.min(providerMin, previewMax))

  const usedQty = new Set<number>()
  const isTooRound = (n: number) => n % 50 === 0 || n % 25 === 0 || n % 10 === 0

  const pickQty = (want: number, prev: number | null) => {
    const target = Math.max(floor, Math.min(cap, want))
    for (let step = 0; step <= cap; step++) {
      const options = step === 0
        ? [target]
        : (Math.random() < 0.5 ? [target + step, target - step] : [target - step, target + step])
      for (const opt of options) {
        if (opt < floor || opt > cap) continue
        if (usedQty.has(opt)) continue
        if (prev !== null && Math.abs(opt - prev) < 3) continue
        if (isTooRound(opt) && base.length > 1) continue
        return opt
      }
    }
    // last resort: first free value
    for (let opt = floor; opt <= cap; opt++) if (!usedQty.has(opt)) return opt
    return target
  }

  // 1) Random organic quantity per run (±25% wobble around preview value)
  base.forEach((run, i) => {
    const wobble = 0.75 + Math.random() * 0.5
    const want = Math.round(run.quantity_to_send * wobble)
    const prev = i > 0 ? base[i - 1].quantity_to_send : null
    const qty = pickQty(want, prev)
    run.quantity_to_send = qty
    run.base_quantity = qty
    usedQty.add(qty)
  })

  // 2) Reconcile total so the customer still gets the exact ordered quantity
  let drift = totalTargetQty - base.reduce((s, r) => s + r.quantity_to_send, 0)
  let guard = 0
  while (drift !== 0 && guard < 20000) {
    guard++
    let changed = false
    const order = base
      .map((r, index) => ({ index, q: r.quantity_to_send, rand: Math.random() }))
      .sort((a, b) => drift > 0 ? a.q - b.q || a.rand - b.rand : b.q - a.q || a.rand - b.rand)
      .map((x) => x.index)

    for (const index of order) {
      const step = drift > 0 ? 1 : -1
      const next = base[index].quantity_to_send + step
      const prev = index > 0 ? base[index - 1].quantity_to_send : null
      const after = index < base.length - 1 ? base[index + 1].quantity_to_send : null
      if (next < floor || next > cap) continue
      if (usedQty.has(next)) continue
      if (prev !== null && Math.abs(next - prev) < 3) continue
      if (after !== null && Math.abs(next - after) < 3) continue

      usedQty.delete(base[index].quantity_to_send)
      base[index].quantity_to_send = next
      base[index].base_quantity = next
      usedQty.add(next)
      drift += drift > 0 ? -1 : 1
      changed = true
      if (drift === 0) break
    }
    if (!changed) break
  }

  if (drift !== 0) {
    const last = base[base.length - 1]
    last.quantity_to_send = Math.max(1, last.quantity_to_send + drift)
    last.base_quantity = last.quantity_to_send
  }

  // 3) Random organic timing: every gap different, never a fixed rhythm
  const firstAt = base[0].at
  const spanMs = Math.max(base.length * 5 * 60000, base[base.length - 1].at - firstAt)
  const avgGap = spanMs / Math.max(1, base.length - 1)
  const usedGaps = new Set<number>()
  let cursor = firstAt

  base.forEach((run, i) => {
    if (i === 0) {
      run.at = firstAt
      return
    }
    let gap = 0
    for (let attempt = 0; attempt < 60; attempt++) {
      const wobble = 0.45 + Math.random() * 1.25
      const burst = Math.random() < 0.18 ? 0.35 : 1
      const candidate = Math.round(avgGap * wobble * burst / 60000) // minutes
      const minutes = Math.max(4, candidate) + (Math.random() < 0.5 ? 0 : 1)
      const secs = Math.floor(Math.random() * 60)
      const g = minutes * 60000 + secs * 1000
      if (usedGaps.has(minutes)) continue
      usedGaps.add(minutes)
      gap = g
      break
    }
    if (!gap) gap = Math.round(avgGap) + Math.floor(Math.random() * 180000)
    cursor += gap
    run.at = cursor
  })

  return base.map((run, i) => ({
    run_number: i + 1,
    scheduled_at: new Date(run.at).toISOString(),
    quantity_to_send: run.quantity_to_send,
    base_quantity: run.base_quantity,
    variance_applied: run.variance_applied,
    peak_multiplier: run.peak_multiplier,
    status: 'pending'
  }))
}


// COMPLETE SERVICE-SPECIFIC CONFIGS
const MAX_BATCH_CAPS: Record<string, number> = {
  views: 200, likes: 35, comments: 3, saves: 20, shares: 25,
  followers: 8, subscribers: 5, retweets: 35, reposts: 30,
  watch_hours: 1, story_views: 200, impressions: 300, reach: 250,
  profile_visits: 15, mentions: 3, quotes: 4, bookmarks: 25,
  favorites: 35, plays: 200, listens: 150, downloads: 5, generic: 50,
}

const MIN_INTERVAL_CAPS: Record<string, number> = {
  views: 25, likes: 40, comments: 90, saves: 55, shares: 75,
  followers: 150, subscribers: 180, retweets: 35, reposts: 42,
  watch_hours: 240, story_views: 20, impressions: 28, reach: 30,
  profile_visits: 65, mentions: 120, quotes: 95, bookmarks: 50,
  favorites: 45, plays: 22, listens: 28, downloads: 85, generic: 50,
}

const SERVICE_CONFIGS: Record<ServiceCategory, OrganicServiceConfig> = {
  views: {
    baseIntervalMinutes: 45, intervalVariance: 25, quantityVariancePercent: 55,
    spikeChance: 0.08, spikeMagnitude: [1.2, 1.5], dipChance: 0.20, dipMagnitude: [0.5, 0.8],
    burstChance: 0.05, pauseChance: 0.25, patternBreakerChance: 0.30,
    peakHourBoost: 1.3, nightReduction: 0.25, runsPerThousand: 20,
    minRunsPerOrder: 25, maxRunsPerOrder: 300, targetHumanScore: [85, 99], defaultMinQty: 100
  },
  likes: {
    baseIntervalMinutes: 85, intervalVariance: 45, quantityVariancePercent: 70,
    spikeChance: 0.04, spikeMagnitude: [1.1, 1.35], dipChance: 0.30, dipMagnitude: [0.35, 0.65],
    burstChance: 0.02, pauseChance: 0.35, patternBreakerChance: 0.40,
    peakHourBoost: 1.15, nightReduction: 0.15, runsPerThousand: 180, 
    minRunsPerOrder: 10, maxRunsPerOrder: 200, targetHumanScore: [88, 99], defaultMinQty: 10
  },
  comments: {
    baseIntervalMinutes: 150, intervalVariance: 80, quantityVariancePercent: 75,
    spikeChance: 0.03, spikeMagnitude: [1.1, 1.3], dipChance: 0.40, dipMagnitude: [0.4, 0.7],
    burstChance: 0.02, pauseChance: 0.50, patternBreakerChance: 0.40,
    peakHourBoost: 1.15, nightReduction: 0.10, runsPerThousand: 250,
    minRunsPerOrder: 15, maxRunsPerOrder: 150, targetHumanScore: [92, 99], defaultMinQty: 5
  },
  followers: {
    baseIntervalMinutes: 300, intervalVariance: 150, quantityVariancePercent: 65,
    spikeChance: 0.02, spikeMagnitude: [1.1, 1.3], dipChance: 0.35, dipMagnitude: [0.45, 0.7],
    burstChance: 0.01, pauseChance: 0.55, patternBreakerChance: 0.35,
    peakHourBoost: 1.1, nightReduction: 0.15, runsPerThousand: 80,
    minRunsPerOrder: 15, maxRunsPerOrder: 120, targetHumanScore: [92, 99], defaultMinQty: 10
  },
  subscribers: {
    baseIntervalMinutes: 360, intervalVariance: 180, quantityVariancePercent: 70,
    spikeChance: 0.01, spikeMagnitude: [1.1, 1.2], dipChance: 0.40, dipMagnitude: [0.5, 0.75],
    burstChance: 0.01, pauseChance: 0.60, patternBreakerChance: 0.40,
    peakHourBoost: 1.08, nightReduction: 0.10, runsPerThousand: 120,
    minRunsPerOrder: 12, maxRunsPerOrder: 100, targetHumanScore: [94, 99], defaultMinQty: 10
  },
  retweets: {
    baseIntervalMinutes: 70, intervalVariance: 38, quantityVariancePercent: 60,
    spikeChance: 0.08, spikeMagnitude: [1.2, 1.6], dipChance: 0.18, dipMagnitude: [0.45, 0.7],
    burstChance: 0.06, pauseChance: 0.22, patternBreakerChance: 0.28,
    peakHourBoost: 1.35, nightReduction: 0.22, runsPerThousand: 65,
    minRunsPerOrder: 18, maxRunsPerOrder: 150, targetHumanScore: [82, 97], defaultMinQty: 10
  },
  shares: {
    baseIntervalMinutes: 100, intervalVariance: 55, quantityVariancePercent: 65,
    spikeChance: 0.05, spikeMagnitude: [1.15, 1.4], dipChance: 0.28, dipMagnitude: [0.45, 0.7],
    burstChance: 0.03, pauseChance: 0.35, patternBreakerChance: 0.32,
    peakHourBoost: 1.2, nightReduction: 0.18, runsPerThousand: 250,
    minRunsPerOrder: 3, maxRunsPerOrder: 120, targetHumanScore: [88, 99], defaultMinQty: 10
  },
  saves: {
    baseIntervalMinutes: 110, intervalVariance: 60, quantityVariancePercent: 65,
    spikeChance: 0.04, spikeMagnitude: [1.15, 1.4], dipChance: 0.30, dipMagnitude: [0.45, 0.72],
    burstChance: 0.03, pauseChance: 0.38, patternBreakerChance: 0.30,
    peakHourBoost: 1.18, nightReduction: 0.15, runsPerThousand: 180,
    minRunsPerOrder: 2, maxRunsPerOrder: 100, targetHumanScore: [86, 98], defaultMinQty: 10
  },
  watch_hours: {
    baseIntervalMinutes: 480, intervalVariance: 240, quantityVariancePercent: 55,
    spikeChance: 0.01, spikeMagnitude: [1.05, 1.2], dipChance: 0.45, dipMagnitude: [0.55, 0.8],
    burstChance: 0.005, pauseChance: 0.65, patternBreakerChance: 0.25,
    peakHourBoost: 1.05, nightReduction: 0.30, runsPerThousand: 1000,
    minRunsPerOrder: 8, maxRunsPerOrder: 50, targetHumanScore: [95, 99], defaultMinQty: 1
  },
  reposts: {
    baseIntervalMinutes: 85, intervalVariance: 45, quantityVariancePercent: 60,
    spikeChance: 0.07, spikeMagnitude: [1.2, 1.5], dipChance: 0.22, dipMagnitude: [0.42, 0.68],
    burstChance: 0.05, pauseChance: 0.28, patternBreakerChance: 0.28,
    peakHourBoost: 1.28, nightReduction: 0.20, runsPerThousand: 120,
    minRunsPerOrder: 2, maxRunsPerOrder: 120, targetHumanScore: [84, 97], defaultMinQty: 10
  },
  generic: {
    baseIntervalMinutes: 80, intervalVariance: 45, quantityVariancePercent: 60,
    spikeChance: 0.05, spikeMagnitude: [1.15, 1.4], dipChance: 0.25, dipMagnitude: [0.45, 0.72],
    burstChance: 0.04, pauseChance: 0.32, patternBreakerChance: 0.30,
    peakHourBoost: 1.2, nightReduction: 0.20, runsPerThousand: 50,
    minRunsPerOrder: 2, maxRunsPerOrder: 150, targetHumanScore: [85, 98], defaultMinQty: 10
  }
}

const PROVIDER_MINIMUMS: Record<string, number> = {
  views: 100, likes: 10, comments: 10, saves: 10, shares: 10, followers: 10,
  subscribers: 10, retweets: 10, reposts: 10, watch_hours: 10,
}

const DAILY_PATTERNS: number[] = [
  0.3, 0.2, 0.1, 0.1, 0.15, 0.3,   // 0-5 AM
  0.5, 0.7, 0.9, 1.0, 1.1, 1.2,   // 6-11 AM
  1.0, 0.9, 0.8, 0.85, 0.9, 1.0,  // 12-5 PM
  1.3, 1.5, 1.6, 1.5, 1.2, 0.8,   // 6-11 PM
]

function getServiceConfig(engType: string): OrganicServiceConfig {
  return SERVICE_CONFIGS[engType as ServiceCategory] || SERVICE_CONFIGS.generic
}

const supabaseModule = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const supabase = supabaseModule
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const authHeader = req.headers.get('Authorization') || ''
    const token = authHeader.replace('Bearer ', '')
    const body = await req.json()

    // ---------- INTERNAL / RESUME MODE ----------
    // Body: { engagement_order_id }. Order + items already exist and wallet already debited.
    // Allowed if caller has service-role token OR is the order owner (or admin).
    const isServiceRole = !!body?.engagement_order_id && token === SERVICE_KEY
    let isResumeOwner = false
    if (!isServiceRole && body?.engagement_order_id) {
      const { data: { user: reqUser } } = await supabase.auth.getUser(token)
      if (reqUser) {
        const { data: ordCheck } = await supabase.from('engagement_orders').select('user_id').eq('id', body.engagement_order_id).maybeSingle()
        if (ordCheck?.user_id === reqUser.id) isResumeOwner = true
        if (!isResumeOwner) {
          const { data: adminRow } = await supabase.from('user_roles').select('role').eq('user_id', reqUser.id).eq('role', 'admin').maybeSingle()
          if (adminRow) isResumeOwner = true
        }
      }
    }
    const isInternal = isServiceRole || isResumeOwner
    let user_id: string

    let link: string
    let bundle_id: string | null = null
    let aiOrganicEnabled = true
    let newBalance = 0
    let order: any
    let createdItemIds: Array<{ type: string; itemId: string; engagement: any; finalServiceId: string }> = []

    if (isInternal) {
      const { data: ord, error: ordErr } = await supabase
        .from('engagement_orders')
        .select('*')
        .eq('id', body.engagement_order_id)
        .single()
      if (ordErr || !ord) return new Response(JSON.stringify({ error: 'Order not found' }), { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      order = ord
      user_id = ord.user_id
      link = ord.link
      bundle_id = ord.bundle_id

      if (bundle_id) {
        const { data: bundle } = await supabase.from('engagement_bundles').select('ai_organic_enabled').eq('id', bundle_id).single()
        if (bundle) aiOrganicEnabled = bundle.ai_organic_enabled ?? true
      }

      const { data: items } = await supabase
        .from('engagement_order_items')
        .select('id, engagement_type, service_id, quantity, price, drip_interval, drip_interval_unit')
        .eq('engagement_order_id', order.id)
      for (const it of items ?? []) {
        createdItemIds.push({
          type: it.engagement_type,
          itemId: it.id,
          finalServiceId: it.service_id,
          engagement: {
            type: it.engagement_type,
            service_id: it.service_id,
            quantity: it.quantity,
            price: it.price,
            time_limit_hours: 0,
            peak_hours_enabled: ord.peak_hours_enabled ?? false,
            scheduled_runs: [],
          },
        })
      }

      if (createdItemIds.length === 0) {
        throw new Error('Order has no engagement items to schedule')
      }

      // Flip order to processing so UI shows correct state
      await supabase.from('engagement_orders').update({ status: 'processing' }).eq('id', order.id)
    } else {
      // ---------- NORMAL USER FLOW ----------
      const { data: { user }, error: authError } = await supabase.auth.getUser(token)
      if (authError || !user) {
        console.error('Auth error:', authError)
        return new Response(JSON.stringify({ error: authError?.message || 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }
      user_id = user.id

      // Subscription (or admin) is mandatory before any order can be created.
      const eligibility = await assertPaymentEligible(supabase, user_id, {
        source: 'process-engagement-order',
        request: req,
      })
      if (!eligibility.ok) {
        return new Response(JSON.stringify({ error: eligibility.error }), { status: eligibility.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      const { bundle_id: bId, link: reqLink, total_price, engagements, base_quantity, campaign_name } = body
      bundle_id = bId
      link = reqLink
      const sanitizedCampaignName = typeof campaign_name === 'string'
        ? campaign_name.trim().slice(0, 120) || null
        : null

      if (!bundle_id || !Array.isArray(engagements) || engagements.length === 0 || !total_price || total_price <= 0) {
        return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      const { data: bItems, error: biErr } = await supabase
        .from('bundle_items')
        .select('id, service_id, engagement_type, price_per_k, services:service_id(price)')
        .eq('bundle_id', bundle_id)
      if (biErr || !bItems || bItems.length === 0) {
        return new Response(JSON.stringify({ error: 'Bundle not found' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      let expectedTotal = 0
      for (const eng of engagements) {
        const qty = Math.max(0, Math.floor(Number(eng?.quantity) || 0))
        if (qty <= 0) {
          return new Response(JSON.stringify({ error: 'Invalid engagement quantity' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }
        const match = bItems.find((b: any) => b.engagement_type === eng.type && (!eng.service_id || b.service_id === eng.service_id))
        if (!match) {
          return new Response(JSON.stringify({ error: `Engagement ${eng.type} not in bundle` }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
        }
        const pricePerK = Number(match.price_per_k ?? (match as any).services?.price ?? 0)
        expectedTotal += (qty / 1000) * pricePerK
      }

      if (expectedTotal <= 0 || Math.abs(Number(total_price) - expectedTotal) / expectedTotal > 0.01) {
        return new Response(JSON.stringify({ error: 'Price mismatch' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      }

      const { data: wallet } = await supabase.from('wallets').select('*').eq('user_id', user_id).single()
      if (!wallet || wallet.balance < total_price) return new Response(JSON.stringify({ error: 'Insufficient balance' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

      newBalance = wallet.balance - total_price
      const newSpent = (wallet.total_spent || 0) + total_price
      await supabase.from('wallets').update({ balance: newBalance, total_spent: newSpent, updated_at: new Date().toISOString() }).eq('id', wallet.id)

      if (bundle_id) {
        const { data: bundle } = await supabase.from('engagement_bundles').select('ai_organic_enabled').eq('id', bundle_id).single()
        if (bundle) aiOrganicEnabled = bundle.ai_organic_enabled ?? true
      }

      const { data: ord, error: orderError } = await supabase.from('engagement_orders').insert({
        user_id, bundle_id, link, total_price, base_quantity, is_organic_mode: true, status: 'processing',
        campaign_name: sanitizedCampaignName,
      }).select().single()

      if (orderError || !ord) return new Response(JSON.stringify({ error: `Failed to create order: ${orderError?.message || 'Unknown error'}` }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
      order = ord

      await supabase.from('transactions').insert({
        user_id,
        type: 'order_payment',
        amount: total_price,
        balance_after: newBalance,
        order_id: order.id,
        status: 'completed',
        description: `Engagement Order #${order.order_number}`,
      })

      for (const eng of engagements) {
        const { data: item } = await supabase.from('engagement_order_items').insert({
          engagement_order_id: order.id,
          engagement_type: eng.type,
          service_id: eng.service_id,
          quantity: eng.quantity,
          price: eng.price,
          status: 'pending'
        }).select().single()
        if (!item) {
          throw new Error(`Failed to create ${eng.type} order item`)
        }
        createdItemIds.push({ type: eng.type, itemId: item.id, engagement: eng, finalServiceId: eng.service_id })
      }
    }


    const backgroundWork = async () => {
      try {
        const startTime = new Date()
        const detectPlatform = (url: string): string => {
          const l = url.toLowerCase()
          if (l.includes('instagram.com')) return 'instagram'
          if (l.includes('tiktok.com')) return 'tiktok'
          if (l.includes('youtube.com')) return 'youtube'
          if (l.includes('twitter.com') || l.includes('x.com')) return 'twitter'
          return 'generic'
        }
        const platform = detectPlatform(link)

        const PLATFORM_PRIORITIES: Record<string, number> = {
          views: 1, impressions: 1, plays: 1, watch_hours: 1, reach: 1,
          likes: 2, favorites: 2,
          comments: 3,
          saves: 4, bookmarks: 4,
          shares: 5, retweets: 5, reposts: 5,
          followers: 6, subscribers: 6,
          generic: 10
        }

        const platformStagger: Record<string, { base: number, variance: number }> = {
          views: { base: 0, variance: 0 },
          likes: { base: 45, variance: 30 },
          comments: { base: 90, variance: 60 },
          generic: { base: 30, variance: 30 }
        }

        const platformDailyPattern = DAILY_PATTERNS
        const sortedItems = [...createdItemIds].sort((a,b) => (PLATFORM_PRIORITIES[a.type] || 10) - (PLATFORM_PRIORITIES[b.type] || 10))

        let viewsStartTime: Date | null = null
        let viewsFirstRunScheduled = false
        let viewsEndTime: Date | null = null
        let viewsDurationMinutes = 0

        for (const { type: engType, itemId, engagement, finalServiceId } of sortedItems) {
          const config = getServiceConfig(engType)
          let providerMin = config.defaultMinQty
          if (finalServiceId) {
            const { data: s } = await supabase.from('services').select('min_quantity').eq('id', finalServiceId).single()
            if (s?.min_quantity) providerMin = s.min_quantity
          }
          // Enforce platform minimum floors (e.g. views must be >= 100)
          const floorMin = PROVIDER_MINIMUMS[engType] || 0
          if (floorMin > 0) providerMin = Math.max(providerMin, floorMin)

          const isViewType = ['views', 'impressions', 'reach', 'plays', 'watch_hours'].includes(engType)
          const stagger = platformStagger[engType] || platformStagger.generic
          const priority = PLATFORM_PRIORITIES[engType] || 10

          let initialDelayMinutes = 0
          if (isViewType && !viewsFirstRunScheduled) {
            // First run must become dispatchable within two minutes; subsequent
            // runs retain the full randomized organic cadence.
            initialDelayMinutes = 0.5 + Math.random() * 0.5
            viewsStartTime = new Date(startTime.getTime() + initialDelayMinutes * 60 * 1000)
            viewsFirstRunScheduled = true
          } else if (viewsStartTime) {
            // Non-view types start shortly AFTER views start so they ramp together,
            // not all-at-once before views begin.
            const stepDelay = 5 + (priority - 1) * 8
            initialDelayMinutes = stepDelay + Math.random() * Math.min(stagger.variance, 15)
          } else {
            initialDelayMinutes = (priority - 1) * 60 + 20 + Math.random() * stagger.variance
          }

          let timeLimitHours = engagement.time_limit_hours || 0
          let peakHoursEnabled = engagement.peak_hours_enabled ?? false
          
          if (aiOrganicEnabled && timeLimitHours === 0) {
            const options = [0, 0, 0, 4, 6, 8, 12]
            timeLimitHours = options[Math.floor(Math.random() * options.length)]
          }

          // ORGANIC SYNC: Non-view engagements MUST span the same total window as views.
          // This prevents likes/saves/shares from finishing before views have arrived.
          if (!isViewType && viewsDurationMinutes > 0) {
            const viewsHours = viewsDurationMinutes / 60
            // Always match views window (override any auto time limit)
            timeLimitHours = Math.max(viewsHours, 0.25)
          }

          let baseInterval = config.baseIntervalMinutes
          let intervalRange = config.intervalVariance
          const baseMaxBatchCap = MAX_BATCH_CAPS[engType] || MAX_BATCH_CAPS.generic
          let maxBatchCap = Math.max(baseMaxBatchCap, Math.round(providerMin * 2.5))
          const minIntCap = MIN_INTERVAL_CAPS[engType] || MIN_INTERVAL_CAPS.generic

          let idealRuns = Math.round((engagement.quantity / 1000) * config.runsPerThousand)
          const maxPosForQty = Math.max(1, Math.floor(engagement.quantity / providerMin))
          const absoluteMaxRuns = Math.max(1, Math.floor(maxPosForQty * 0.8))
          
          let targetRuns: number
          let timeLimitApplied = false

          if (timeLimitHours > 0) {
            const totalMinutes = timeLimitHours * 60
            const availableMinutes = Math.max(30, totalMinutes - initialDelayMinutes)
            const maxPosRuns = Math.floor(availableMinutes / 5)
            
            let initialTarget = Math.min(maxPosRuns, Math.max(config.minRunsPerOrder, Math.min(config.maxRunsPerOrder, idealRuns)))
            // Clamp targetRuns first so baseInterval spans the entire time limit
            targetRuns = Math.min(initialTarget, absoluteMaxRuns)
            if (targetRuns < 2 && engagement.quantity >= providerMin * 2) targetRuns = 2
            
            const avgNeeded = Math.ceil(engagement.quantity / targetRuns)
            maxBatchCap = Math.max(maxBatchCap, Math.min(avgNeeded * 2, providerMin * 4))
            baseInterval = Math.max(5, availableMinutes / Math.max(targetRuns - 1, 1))
            intervalRange = baseInterval * 0.15
            timeLimitApplied = true
            console.log(`  ⏱️ ${engType}: ${timeLimitHours}h | Stagger ${Math.round(initialDelayMinutes)}m | Int ${baseInterval.toFixed(1)}m | Runs ${targetRuns}`)
          } else {
            targetRuns = Math.max(config.minRunsPerOrder, Math.ceil(engagement.quantity / maxBatchCap), Math.min(config.maxRunsPerOrder, idealRuns))
            targetRuns = Math.min(targetRuns, absoluteMaxRuns)
            if (targetRuns < 2 && engagement.quantity >= providerMin * 2) targetRuns = 2
          }

          const previewRuns = Array.isArray(engagement.scheduled_runs)
            ? (engagement.scheduled_runs as ScheduledRunInput[])
            : []

          let validatedEntries: any[] = []
          const totalTargetQty = engagement.quantity

          if (previewRuns.length > 0) {
            validatedEntries = uniquifyScheduledRuns(previewRuns, totalTargetQty, providerMin, maxBatchCap)
              .map((run) => ({
                engagement_order_item_id: itemId,
                run_number: run.run_number,
                scheduled_at: run.scheduled_at,
                quantity_to_send: run.quantity_to_send,
                base_quantity: run.base_quantity,
                variance_applied: run.variance_applied,
                peak_multiplier: run.peak_multiplier,
                status: 'pending'
              }))
          }

          if (validatedEntries.length === 0) {
            let remaining = engagement.quantity
            let currentTime: Date
            if (isViewType && viewsStartTime) currentTime = new Date(viewsStartTime.getTime())
            else if (viewsStartTime) currentTime = new Date(viewsStartTime.getTime() + initialDelayMinutes * 60 * 1000)
            else currentTime = new Date(startTime.getTime() + initialDelayMinutes * 60 * 1000)

            let runNumber = 1
            const scheduleEntries = []

            while (remaining > 0 && (!timeLimitApplied || runNumber <= targetRuns)) {
              const interval = (baseInterval + (Math.random() * 2 - 1) * intervalRange) * (timeLimitApplied ? 1 : (Math.random() < 0.2 ? 1.5 : 1))
              const scheduledAt = new Date(currentTime.getTime() + (Math.random() * 2 - 1) * 2 * 60 * 1000)
              if (scheduledAt < new Date(startTime.getTime() + 30*1000)) scheduledAt.setTime(startTime.getTime() + 30*1000)

              const istHour = new Date(scheduledAt.getTime() + 5.5*3600000).getUTCHours()
              const multiplier = peakHoursEnabled ? (platformDailyPattern[istHour] || 1) : (0.9 + Math.random()*0.2)
              
              const runsLeft = Math.max(1, targetRuns - runNumber + 1)
              let qty = Math.round((remaining / runsLeft) * (0.8 + Math.random() * 0.4) * multiplier)
              
              qty = Math.max(providerMin, Math.min(qty, remaining, maxBatchCap))
              
              if (runNumber === targetRuns || remaining <= providerMin) {
                qty = remaining
              }

              if (!timeLimitApplied && runNumber > absoluteMaxRuns && remaining > 0) {
                qty = remaining
              }

              scheduleEntries.push({
                engagement_order_item_id: itemId,
                run_number: runNumber,
                scheduled_at: scheduledAt.toISOString(),
                quantity_to_send: qty,
                base_quantity: qty,
                status: 'pending'
              })

              remaining -= qty
              runNumber++
              currentTime = new Date(currentTime.getTime() + Math.max(5, interval) * 60000)
              if (runNumber > 1000) break
            }

            if (remaining > 0 && scheduleEntries.length > 0) {
              scheduleEntries[scheduleEntries.length - 1].quantity_to_send += remaining
              scheduleEntries[scheduleEntries.length - 1].base_quantity += remaining
            }
            
            let carry = 0
            validatedEntries = []

            for (let i = 0; i < scheduleEntries.length; i++) {
              const e = scheduleEntries[i]
              e.quantity_to_send += carry
              e.base_quantity = e.quantity_to_send
              carry = 0
              
              if (e.quantity_to_send < providerMin && i < scheduleEntries.length - 1) {
                carry = e.quantity_to_send
              } else {
                if (e.quantity_to_send > 0) validatedEntries.push(e)
              }
            }

            if (validatedEntries.length >= 2) {
              const lastEntry = validatedEntries[validatedEntries.length - 1]
              if (lastEntry.quantity_to_send < providerMin) {
                const prevEntry = validatedEntries[validatedEntries.length - 2]
                prevEntry.quantity_to_send += lastEntry.quantity_to_send
                prevEntry.base_quantity = prevEntry.quantity_to_send
                validatedEntries.pop()
              }
            }
            
            if (validatedEntries.length === 0 && totalTargetQty > 0) {
              validatedEntries.push({
                engagement_order_item_id: itemId,
                run_number: 1,
                scheduled_at: new Date(startTime.getTime() + 60 * 1000).toISOString(),
                quantity_to_send: Math.max(carry, totalTargetQty),
                base_quantity: Math.max(carry, totalTargetQty),
                status: 'pending'
              })
            }
            
            validatedEntries.forEach((e, i) => e.run_number = i + 1)

            {
              const scheduledSum = validatedEntries.reduce((s, r) => s + r.quantity_to_send, 0)
              const shortfall = totalTargetQty - scheduledSum
              if (shortfall >= providerMin && validatedEntries.length > 0) {
                const perRun = Math.max(providerMin, Math.min(maxBatchCap, Math.ceil(shortfall / Math.max(5, Math.ceil(shortfall / maxBatchCap)))))
                const extraRuns = Math.max(1, Math.ceil(shortfall / perRun))
                const lastTime = new Date(validatedEntries[validatedEntries.length - 1].scheduled_at).getTime()
                let leftover = shortfall
                for (let k = 0; k < extraRuns && leftover > 0; k++) {
                  const qty = (k === extraRuns - 1) ? leftover : Math.min(perRun, leftover)
                  if (qty <= 0) break
                  const t = new Date(lastTime + (k + 1) * (baseInterval * 60 * 1000) + (Math.random() * 2 - 1) * 60 * 1000)
                  validatedEntries.push({
                    engagement_order_item_id: itemId,
                    run_number: validatedEntries.length + 1,
                    scheduled_at: t.toISOString(),
                    quantity_to_send: qty,
                    base_quantity: qty,
                    status: 'pending'
                  })
                  leftover -= qty
                }
                console.log(`🛟 [${engType}] Top-up: scheduled ${scheduledSum}/${totalTargetQty}, added ${extraRuns} runs for shortfall ${shortfall}`)
              }
            }
            validatedEntries.forEach((e, i) => e.run_number = i + 1)

            // Final organic pass: random unique quantities + random unique gaps
            validatedEntries = uniquifyScheduledRuns(validatedEntries, totalTargetQty, providerMin, maxBatchCap)
              .map((run) => ({ ...run, engagement_order_item_id: itemId }))

          }

          if (validatedEntries.length > 0) {
            const { error: schedErr } = await supabase.from('organic_run_schedule').insert(validatedEntries)
            if (schedErr) {
               console.error(`❌ [${engType}] Insert error:`, schedErr.message)
               throw new Error(`Could not schedule ${engType}: ${schedErr.message}`)
            } else {
               const scheduledSum = validatedEntries.reduce((s, r) => s + r.quantity_to_send, 0)
               console.log(`✅ [${engType}] Scheduled ${validatedEntries.length} runs. (Sum: ${scheduledSum}, Target: ${totalTargetQty})`)
            }
            // Capture the views window so non-view types can mirror it
            if (isViewType && !viewsEndTime) {
              const lastAt = validatedEntries.reduce((max, e) => {
                const t = new Date(e.scheduled_at).getTime()
                return t > max ? t : max
              }, 0)
              if (lastAt > 0) {
                viewsEndTime = new Date(lastAt)
                viewsDurationMinutes = Math.max(0, (lastAt - startTime.getTime()) / 60000)
              }
            }
          } else {
            console.warn(`⚠️ [${engType}] No schedule entries created (qty: ${totalTargetQty})`)
            throw new Error(`No schedule entries created for ${engType}`)
          }
        }

        const schedulerKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
        const schedulerResponse = await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/execute-all-runs`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${schedulerKey}`,
            'apikey': schedulerKey,
          },
          body: JSON.stringify({ instant: true, order_id: order.id })
        })
        if (!schedulerResponse.ok) {
          console.error('Immediate scheduler trigger failed:', schedulerResponse.status, await schedulerResponse.text())
        }
      } catch (err: any) { console.error('Background error:', err?.message || err) }
    }

    // Schedule creation is part of placing an order. Await it so self-hosted edge
    // runtimes cannot terminate the work after the HTTP response is returned.
    await backgroundWork()

    return new Response(JSON.stringify({ success: true, order_id: order.id, new_balance: newBalance }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })

  } catch (error) {
    console.error('Error:', error)
      return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  }
})
