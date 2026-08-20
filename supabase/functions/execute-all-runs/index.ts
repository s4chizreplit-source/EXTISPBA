import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { notifyUserTelegram, statusEmoji } from "../_shared/notify.ts"

// Sends a Telegram message to the order owner if the engagement_orders status just changed
// to a notify-worthy state. Safe to call multiple times — no-op on unchanged state.
async function notifyEngagementOrderStatus(supabase: any, engagementOrderId: string, prevStatus: string | null | undefined, newStatus: string) {
  try {
    if (!engagementOrderId || !newStatus) return
    if (prevStatus === newStatus) return
    const NOTIFY = new Set(['processing', 'completed', 'partial', 'failed', 'cancelled'])
    if (!NOTIFY.has(newStatus)) return
    const { data: o } = await supabase
      .from('engagement_orders')
      .select('user_id, order_number, link')
      .eq('id', engagementOrderId)
      .maybeSingle()
    if (!o?.user_id) return
    const label: Record<string, string> = {
      processing: 'Processing started',
      completed: 'Delivered ✅',
      partial: 'Partially delivered',
      failed: 'Failed',
      cancelled: 'Cancelled',
    }
    await notifyUserTelegram(
      supabase,
      o.user_id,
      `${statusEmoji(newStatus)} <b>Order #${o.order_number}</b>\n${label[newStatus] ?? newStatus}\nLink: <code>${o.link ?? ''}</code>`,
    )
  } catch (e) {
    console.error('notifyEngagementOrderStatus failed', e)
  }
}


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

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000
const MAX_RUN_RETRIES = 9999
// Providers that serialize orders per link usually need more than one minute.
// Retrying every minute only refreshes the local busy marker and creates a
// self-sustaining postpone loop, so use a real cooldown before asking again.
const ACTIVE_ORDER_RETRY_MS = 3 * 60 * 1000
const TEMPORARY_RETRY_MS = 60 * 1000
// A local provider lock is only a cache of the last status check. Re-probe stale
// locks instead of allowing an old Pending/In-progress response to block one
// link forever. The provider API remains authoritative and may reject the add.
const STALE_PROVIDER_LOCK_MS = 10 * 60 * 1000

const TEMPORARY_ERRORS = [
  'balance', 'not have enough', 'processing another transaction',
  'active order with this link', 'wait until order being completed',
  'rate limit', 'timeout', 'temporarily', 'too many requests',
  'already has an order', 'order in progress', 'link currently active',
  'processing previous order', 'wait for completion',
]

const ACCOUNT_SPECIFIC_ERRORS = [
  'invalid api key', 'api key not found', 'invalid key',
  'unauthorized', 'authentication failed', 'wrong api key', 'api key invalid',
]

const TRY_NEXT_PROVIDER_ERRORS = [
  'quantity less than minimal', 'quantity less than minimum', 'min quantity',
  'minimum order', 'minimum quantity', 'max quantity', 'maximum quantity',
  'quantity more than maximum', 'service not found', 'incorrect service',
  'invalid service', 'service unavailable', 'service is not available',
  'disabled', 'not work', 'maintenance', 'down',
]

interface ProviderAccount {
  id: string
  provider_id: string
  name: string
  api_key: string
  api_url: string
  priority: number
  is_active: boolean
  last_used_at: string | null
  delivery_multiplier?: number | null
}

interface ServiceMapping {
  id: string
  service_id: string
  provider_account_id: string
  provider_service_id: string
  sort_order: number
  is_active: boolean
  provider_account: ProviderAccount
}

// Module-level caches
const balanceCache = new Map<string, { balance: number; checkedAt: number }>()
const zeroBalanceAlertCache = new Map<string, number>()
const fallbackAlertCache = new Map<string, number>()
const ALERT_THROTTLE_MS = 60 * 60 * 1000 // 1 hour

async function notifyAdminTelegram(message: string) {
  try {
    const url = `${Deno.env.get('SUPABASE_URL')}/functions/v1/send-telegram-notification`
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, parse_mode: 'HTML' }),
    })
  } catch (e) {
    console.error('Telegram notify failed:', e)
  }
}

async function alertZeroBalance(account: ProviderAccount) {
  const last = zeroBalanceAlertCache.get(account.id) || 0
  if (Date.now() - last < ALERT_THROTTLE_MS) return
  zeroBalanceAlertCache.set(account.id, Date.now())
  await notifyAdminTelegram(
    `⚠️ <b>Provider balance is 0</b>\nProvider: <b>${account.name}</b>\nAPI: ${account.api_url}\nPlease add funds — orders to this account are being skipped.`
  )
}

async function alertFallbackUsed(primary: string | null, backup: ProviderAccount, serviceLabel: string) {
  const key = `${backup.id}:${serviceLabel}`
  const last = fallbackAlertCache.get(key) || 0
  if (Date.now() - last < ALERT_THROTTLE_MS) return
  fallbackAlertCache.set(key, Date.now())
  await notifyAdminTelegram(
    `🔁 <b>Fallback provider used</b>\nService: <code>${serviceLabel}</code>\nPrimary failed: <b>${primary ?? 'unknown'}</b>\nBackup placed: <b>${backup.name}</b>`
  )
}

const supabaseModule = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
)

// ==========================================
// OPTIMIZED: Per-invocation mapping cache
// Avoids repeated DB queries for same service
// ==========================================
class MappingCache {
  private cache = new Map<string, { account: ProviderAccount; providerServiceId: string; minQuantity: number; isBackup: boolean }[]>()

  markUsed(serviceId: string, accountId: string) {
    const entries = this.cache.get(serviceId)
    const used = entries?.find((entry) => entry.account.id === accountId)
    if (used) used.account.last_used_at = new Date().toISOString()
  }
  
  async getForService(supabase: any, serviceId: string, excludeIds: string[], executionId: string): Promise<{ account: ProviderAccount; providerServiceId: string; minQuantity: number; isBackup: boolean }[]> {
    // Fetch once per service per invocation
    if (!this.cache.has(serviceId)) {
      const { data: mappings, error } = await supabase
        .from('service_provider_mapping')
        .select(`*, provider_account:provider_accounts!service_provider_mapping_provider_account_id_fkey(*), backup_provider_account:provider_accounts!service_provider_mapping_backup_provider_account_id_fkey(*)`)
        .eq('service_id', serviceId)
        .eq('is_active', true)
        .order('sort_order', { ascending: true })
      
      if (error) {
        console.error(`❌ Provider mapping query failed for service ${serviceId} [${executionId}]: ${error.message}`)
        this.cache.set(serviceId, [])
      } else if (!mappings || mappings.length === 0) {
        console.error(`❌ No active service_provider_mapping for service ${serviceId} [${executionId}]`)
        this.cache.set(serviceId, [])
      } else {
        // Rotate mapped accounts by least-recently-used first. `sort_order` is
        // only a deterministic tie-breaker; treating it as a permanent primary
        // priority made every run return to panel #1 even when 2/3 were mapped.
        const sorted = [...mappings].sort((a: any, b: any) => {
          const aTime = a.provider_account?.last_used_at ? new Date(a.provider_account.last_used_at).getTime() : 0
          const bTime = b.provider_account?.last_used_at ? new Date(b.provider_account.last_used_at).getTime() : 0
          if (aTime !== bTime) return aTime - bTime
          const aPriority = a.sort_order || 0
          const bPriority = b.sort_order || 0
          return aPriority - bPriority
        })
        
        const providerServiceIds = sorted
          .flatMap((m: any) => [m.provider_service_id, m.backup_provider_service_id])
          .filter(Boolean)
        const minByKey = new Map<string, number>()
        if (providerServiceIds.length > 0) {
          const { data: providerSvcRows } = await supabase
            .from('services')
            .select('provider_service_id, provider_id, min_quantity')
            .in('provider_service_id', providerServiceIds)
          if (providerSvcRows) {
            for (const row of providerSvcRows as any[]) {
              minByKey.set(`${row.provider_id}:${row.provider_service_id}`, Number(row.min_quantity || 0))
            }
          }
        }

        const accounts: { account: ProviderAccount; providerServiceId: string; minQuantity: number; isBackup: boolean }[] = []
        const pushed = new Set<string>()
        const pushAccount = (account: ProviderAccount | null | undefined, providerServiceId: string | null | undefined, isBackup: boolean) => {
          if (!account || !providerServiceId) return
          if (!account.is_active) return
          if (!account.api_key?.trim()) {
            console.error(`❌ Skipping provider ${account.name}: blank api_key`)
            return
          }
          if (!isValidHttpUrl(account.api_url)) {
            console.log(`⚠️ Skipping provider ${account.name}: invalid api_url`)
            return
          }
          const dedupKey = `${account.id}:${providerServiceId}`
          if (pushed.has(dedupKey)) return
          pushed.add(dedupKey)
          const legacyKey = `${account.provider_id}:${providerServiceId}`
          const serviceKey = `${account.provider_id?.replace(/just$/i, '')}:${providerServiceId}`
          accounts.push({
            account,
            providerServiceId,
            minQuantity: minByKey.get(legacyKey) || minByKey.get(serviceKey) || 0,
            isBackup,
          })
        }

        // Primary mappings first
        for (const mapping of sorted) {
          pushAccount(mapping.provider_account as ProviderAccount, mapping.provider_service_id, false)
        }
        // Auto-fallback: backup providers appended after primaries
        for (const mapping of sorted) {
          const backupAcc = mapping.backup_provider_account as ProviderAccount | undefined
          const backupSvc = mapping.backup_provider_service_id || mapping.provider_service_id
          if (backupAcc) {
            pushAccount(backupAcc, backupSvc, true)
          }
        }
        this.cache.set(serviceId, accounts)
      }
    }
    
    // Return filtered copy (excluding busy accounts)
    const all = this.cache.get(serviceId) || []
    return all
      .filter(a => !excludeIds.includes(a.account.id))
      .sort((a, b) => {
        const aTime = a.account.last_used_at ? new Date(a.account.last_used_at).getTime() : 0
        const bTime = b.account.last_used_at ? new Date(b.account.last_used_at).getTime() : 0
        return aTime - bTime
      })
  }
  
  hasAnyForService(serviceId: string): boolean {
    return (this.cache.get(serviceId) || []).length > 0
  }
}

async function checkProviderBalance(account: ProviderAccount): Promise<{ hasBalance: boolean; balance: number }> {
  if (!isValidHttpUrl(account.api_url)) {
    console.log(`⚠️ Balance check skipped for ${account.name}: invalid api_url`)
    return { hasBalance: false, balance: 0 }
  }

  const cached = balanceCache.get(account.id)
  if (cached && Date.now() - cached.checkedAt < 30000) {
    return { hasBalance: cached.balance > 0, balance: cached.balance }
  }

  try {
    const formData = new URLSearchParams()
    formData.append('key', account.api_key)
    formData.append('action', 'balance')

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(account.api_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
      signal: controller.signal,
    })

    clearTimeout(timeoutId)
    const responseText = await response.text()

    let result
    try { result = JSON.parse(responseText) } catch {
      console.log(`⚠️ ${account.name} balance non-JSON response: ${responseText.slice(0, 200)}`)
      return { hasBalance: true, balance: -1 }
    }

    const balance = parseFloat(result.balance || result.funds || result.amount || '0')
    balanceCache.set(account.id, { balance, checkedAt: Date.now() })
    console.log(`💰 ${account.name} balance: ${balance}`)
    if (balance === 0) {
      alertZeroBalance(account).catch(() => {})
    }
    return { hasBalance: balance > 0, balance }
  } catch (error) {
    return { hasBalance: true, balance: -1 }
  }
}

async function updateAccountLastUsed(supabase: any, accountId: string) {
  await supabase
    .from('provider_accounts')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', accountId)
}

async function claimRunLock(params: {
  supabase: any
  runId: string
  expectedStatus: 'pending' | 'failed'
  updates: Record<string, any>
}) {
  const { data, error } = await params.supabase
    .from('organic_run_schedule')
    .update(params.updates)
    .eq('id', params.runId)
    .eq('status', params.expectedStatus)
    .select('id, status')
    .maybeSingle()

  return {
    error,
    locked: !!data,
    row: data,
  }
}

function hasUncertainDispatch(row: any) {
  const message = (row?.error_message || '').toLowerCase()
  if (message.includes('[dispatch uncertain]') || message.includes('[awaiting provider confirmation]')) {
    return true
  }

  return Boolean(
    row?.provider_response &&
    typeof row.provider_response === 'object' &&
    row.provider_response.uncertain_dispatch === true,
  )
}

type ProviderStatusCheckResult =
  | { ok: true; data: any; rawText: string }
  | { ok: false; error: string; rawText: string }

async function checkProviderOrderStatusWithRetries(params: {
  apiUrl: string; apiKey: string; providerOrderId: string;
  maxAttempts?: number; attemptDelayMs?: number;
}): Promise<ProviderStatusCheckResult> {
  const maxAttempts = params.maxAttempts ?? 3
  const attemptDelayMs = params.attemptDelayMs ?? 2000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const formData = new URLSearchParams()
    formData.append('key', params.apiKey)
    formData.append('action', 'status')
    formData.append('order', params.providerOrderId)

    let rawText = ''
    try {
      const response = await fetch(params.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      })
      rawText = await response.text()

      let result: any
      try { result = JSON.parse(rawText) } catch { result = { error: rawText } }

      if (result?.error || result?.status === 'fail') {
        const err = (result?.message || result?.error || 'Provider status error')?.toString()
        const retryableNotFound = err.toLowerCase().includes('not found') ||
          err.toLowerCase().includes('incorrect order') || err.toLowerCase().includes('wrong order')

        if (retryableNotFound && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, attemptDelayMs))
          continue
        }
        return { ok: false, error: err, rawText }
      }
      return { ok: true, data: result, rawText }
    } catch (e: any) {
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, attemptDelayMs))
        continue
      }
      return { ok: false, error: `Network error: ${e?.message || 'Unknown'}`, rawText }
    }
  }
  return { ok: false, error: 'Unknown provider status error', rawText: '' }
}

const detectPlatformFromLink = (url: string): string | null => {
  const lower = url.toLowerCase()
  if (lower.includes('instagram.com') || lower.includes('instagr.am')) return 'instagram'
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube'
  if (lower.includes('tiktok.com')) return 'tiktok'
  if (lower.includes('twitter.com') || lower.includes('x.com')) return 'twitter'
  if (lower.includes('facebook.com') || lower.includes('fb.com')) return 'facebook'
  return null
}

const detectPlatformFromService = (serviceName: string): string | null => {
  const lower = serviceName.toLowerCase()
  if (lower.includes('instagram') || lower.includes('ig ')) return 'instagram'
  if (lower.includes('youtube') || lower.includes('yt ')) return 'youtube'
  if (lower.includes('tiktok') || lower.includes('tt ')) return 'tiktok'
  if (lower.includes('twitter') || lower.includes('x ')) return 'twitter'
  if (lower.includes('facebook') || lower.includes('fb ')) return 'facebook'
  return null
}

const isValidUUID = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

const isValidHttpUrl = (value?: string | null) => {
  if (!value) return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

const normalizeLink = (value?: string | null) => (value || '').toLowerCase().trim().replace(/\/$/, '')

const isTerminalProviderStatus = (status?: string | null) => {
  const normalized = (status || '').toLowerCase().trim()
  return ['completed', 'complete', 'partial', 'refunded', 'canceled', 'cancelled', 'error', 'failed', 'success', 'refund', 'canscelled'].includes(normalized)
}

const isActiveProviderStatus = (status?: string | null) => {
  const normalized = (status || '').toLowerCase().trim()
  return ['pending', 'in progress', 'processing', 'processing order', 'inprogress', 'awaiting'].includes(normalized)
}

const isFailedProviderStatus = (status?: string | null) => {
  const normalized = (status || '').toLowerCase().trim()
  return ['refunded', 'canceled', 'cancelled', 'error', 'failed', 'refund', 'canscelled'].includes(normalized)
}

const getNestedEngagementOrderLink = (value: any) => {
  if (Array.isArray(value)) {
    return getNestedEngagementOrderLink(value[0])
  }
  if (value?.engagement_order) {
    return getNestedEngagementOrderLink(value.engagement_order)
  }
  return value?.link || ''
}

// ==========================================================================
// HARD INVARIANT: for one (link, engagement_type) a provider account may hold
// at most ONE active provider order. "Active" = provider_order_id present and
// provider_status not terminal (completed / canceled / partial / refunded).
// This is authoritative and independent of the in-app run status, because a run
// can be marked completed locally while the provider is still delivering.
// ==========================================================================
async function getProvidersBusyOnLink(
  supabase: SupabaseClient,
  normalizedLink: string,
  engagementType: string,
  excludeRunId?: string,
): Promise<Set<string>> {
  const busy = new Set<string>()
  if (!normalizedLink) return busy
  const type = (engagementType || '').toLowerCase().trim()

  const { data, error } = await supabase
    .from('organic_run_schedule')
    .select('id, provider_account_id, provider_status, provider_remains, last_status_check, started_at, engagement_order_item:engagement_order_items!inner(engagement_type, engagement_order:engagement_orders!inner(link))')
    .not('provider_order_id', 'is', null)
    .not('provider_account_id', 'is', null)
    .limit(1000)

  if (error) {
    console.error(`⚠️ Busy-provider lookup failed: ${error.message}`)
    return busy
  }

  for (const row of (data || []) as any[]) {
    if (excludeRunId && row.id === excludeRunId) continue
    const rowLink = normalizeLink(getNestedEngagementOrderLink(row.engagement_order_item))
    const rowType = (Array.isArray(row.engagement_order_item)
      ? row.engagement_order_item[0]?.engagement_type
      : row.engagement_order_item?.engagement_type || '').toLowerCase().trim()
    if (rowLink !== normalizedLink || rowType !== type) continue
    if (isTerminalProviderStatus(row.provider_status)) continue
    if (typeof row.provider_remains === 'number' && row.provider_remains <= 0) continue
    const checkedAt = new Date(row.last_status_check || row.started_at || 0).getTime()
    if (checkedAt > 0 && Date.now() - checkedAt >= STALE_PROVIDER_LOCK_MS) continue
    busy.add(row.provider_account_id)
  }
  return busy
}



async function batchPostponeEngagementRunsForLink(
  supabase: SupabaseClient,
  normalizedLink: string,
  engagementType: string,
  scheduledAt: string,
  reason: string,
) {
  if (!normalizedLink) return 0

  const { data: dueRuns, error: dueRunsError } = await supabase
    .from('organic_run_schedule')
    .select('id, engagement_order_item:engagement_order_items!inner(engagement_type, engagement_order:engagement_orders!inner(link))')
    .eq('status', 'pending')
    .not('engagement_order_item_id', 'is', null)
    .lte('scheduled_at', new Date().toISOString())
    .limit(1000)

  if (dueRunsError || !dueRuns?.length) {
    if (dueRunsError) console.error('Failed to load due runs for batch postpone:', dueRunsError)
    return 0
  }

  // Only postpone runs with matching link AND engagement type
  const matchingIds = dueRuns
    .filter((dueRun: any) => {
      const runLink = normalizeLink(dueRun.engagement_order_item?.engagement_order?.link)
      const runType = (dueRun.engagement_order_item?.engagement_type || '').toLowerCase()
      return runLink === normalizedLink && runType === engagementType.toLowerCase()
    })
    .map((dueRun: any) => dueRun.id)

  if (matchingIds.length === 0) return 0

  const { data: updatedRuns, error: updateError } = await supabase
    .from('organic_run_schedule')
    .update({
      scheduled_at: scheduledAt,
      error_message: reason,
      last_status_check: new Date().toISOString(),
    })
    .in('id', matchingIds)
    .select('id')

  if (updateError) {
    console.error('Failed to batch postpone matching runs:', updateError)
    return 0
  }

  return updatedRuns?.length || 0
}

async function updateEngagementOrderStatus(supabase: SupabaseClient, engagementOrderId: string, itemId: string) {
  if (!engagementOrderId) return

  const { data: parentOrder } = await supabase
    .from('engagement_orders')
    .select('status')
    .eq('id', engagementOrderId)
    .maybeSingle()

  if (parentOrder?.status === 'cancelled') return

  if (itemId) {
    const { data: currentItem } = await supabase
      .from('engagement_order_items')
      .select('status')
      .eq('id', itemId)
      .maybeSingle()

    if (currentItem?.status !== 'cancelled') {
      const { data: itemRuns } = await supabase
        .from('organic_run_schedule')
        .select('status')
        .eq('engagement_order_item_id', itemId)

      if (itemRuns && itemRuns.length > 0) {
        const completedCount = itemRuns.filter((r: any) => r.status === 'completed').length
        const failedCount = itemRuns.filter((r: any) => r.status === 'failed').length
        const cancelledCount = itemRuns.filter((r: any) => r.status === 'cancelled').length
        const activeCount = itemRuns.filter((r: any) => r.status === 'pending' || r.status === 'started').length
        const totalRuns = itemRuns.length

        let itemStatus = 'processing'
        if (activeCount > 0) itemStatus = currentItem?.status === 'paused' ? 'paused' : 'processing'
        else if (completedCount === totalRuns) itemStatus = 'completed'
        else if (completedCount > 0 && completedCount + failedCount + cancelledCount === totalRuns) itemStatus = 'partial'
        else if (failedCount + cancelledCount === totalRuns) itemStatus = 'failed'

        await supabase.from('engagement_order_items').update({ status: itemStatus }).eq('id', itemId)
      }
    }
  }

  const { data: allItems } = await supabase
    .from('engagement_order_items')
    .select('status')
    .eq('engagement_order_id', engagementOrderId)

  if (!allItems || allItems.length === 0) return

  const completedItems = allItems.filter((i: any) => i.status === 'completed').length
  const partialItems = allItems.filter((i: any) => i.status === 'partial').length
  const failedItems = allItems.filter((i: any) => i.status === 'failed').length
  const cancelledItems = allItems.filter((i: any) => i.status === 'cancelled').length
  const activeItems = allItems.filter((i: any) => i.status === 'processing' || i.status === 'pending').length
  const totalItems = allItems.length

  let orderStatus = 'processing'
  if (completedItems === totalItems) orderStatus = 'completed'
  else if (failedItems === totalItems) orderStatus = 'failed'
  else if (activeItems === 0 && completedItems + partialItems + failedItems + cancelledItems === totalItems) orderStatus = completedItems > 0 ? 'partial' : failedItems > 0 ? 'failed' : 'cancelled'
  else if (parentOrder?.status === 'paused') orderStatus = 'paused'

  const prevStatus = parentOrder?.status
  await supabase.from('engagement_orders').update({ status: orderStatus }).eq('id', engagementOrderId).neq('status', 'cancelled')
  if (prevStatus !== 'cancelled') {
    await notifyEngagementOrderStatus(supabase, engagementOrderId, prevStatus, orderStatus)
  }
}

async function triggerContinuation(executionId: string, reason: string) {
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    if (!supabaseUrl || !serviceKey) {
      console.error(`⚠️ Cannot continue [${executionId}] - missing backend env vars`)
      return false
    }

    const response = await fetch(`${supabaseUrl}/functions/v1/execute-all-runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${serviceKey}`,
        'apikey': serviceKey,
      },
      body: JSON.stringify({ instant: true, continued_from: executionId, reason }),
    })

    if (!response.ok) {
      const responseText = await response.text()
      console.error(`⚠️ Continuation trigger failed [${executionId}]: ${response.status} ${responseText}`)
      return false
    }

    console.log(`🔁 Continuation queued for [${executionId}] (${reason})`)
    return true
  } catch (error) {
    console.error(`⚠️ Continuation request error [${executionId}]:`, error)
    return false
  }
}

// Declare EdgeRuntime for waitUntil support
declare const EdgeRuntime: { waitUntil(promise: Promise<any>): void }

serve(async (req) => {
  const startTime = Date.now()
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Auth check: system (service-role or CRON_SECRET) or admin user JWT
    const authHeader = req.headers.get('Authorization')
    const supabase = supabaseModule

    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const token = authHeader.replace('Bearer ', '')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    const cronSecret = Deno.env.get('CRON_SECRET') ?? ''
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || PROJECT_ANON_KEY_FALLBACK
    const isSystemCall = (serviceKey && token === serviceKey) || (cronSecret && token === cronSecret) || (anonKey && token === anonKey) || isProjectAnonJwt(token)

    if (!isSystemCall) {
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

    let requestBody: { instant?: boolean } = {}
    try {
      requestBody = await req.json()
    } catch {
      requestBody = {}
    }

    const executionId = crypto.randomUUID().slice(0, 8)
    console.log(`=== EXECUTE ALL ORGANIC RUNS [${executionId}] ===`)

    // Order-placement calls need a guaranteed execution on self-hosted runtimes.
    // Cron calls remain background jobs so the scheduler responds quickly.
    const backgroundWork = processAllRuns(supabase, executionId, startTime)
    let summary: Awaited<ReturnType<typeof processAllRuns>> | null = null

    if (requestBody.instant) {
      summary = await backgroundWork
    } else {
      if (typeof EdgeRuntime !== 'undefined' && typeof EdgeRuntime.waitUntil === 'function') {
        EdgeRuntime.waitUntil(backgroundWork)
      } else {
        await backgroundWork
      }
    }

    return new Response(JSON.stringify({
      success: true, execution_id: executionId,
      message: requestBody.instant ? 'Processing completed' : 'Processing started in background',
      ...(summary ? { summary } : {}),
    }), {
      status: requestBody.instant ? 200 : 202,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error: any) {
    console.error('Execution error:', error)
    return new Response(JSON.stringify({ error: error.message || 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})

async function processAllRuns(supabase: any, executionId: string, startTime: number) {
  try {
    let processed = 0
    let skipped = 0
    let failed = 0
    let retried = 0
    let shouldContinue = false
    let continuationReason: string | null = null
    const results: any[] = []

    // ==========================================
    // OPTIMIZATION: Single mapping cache for entire invocation
    // ==========================================
    const mappingCache = new MappingCache()

    // ==========================================
    // PRE-FETCH ALL DATA IN PARALLEL (batch queries)
    // ==========================================
    const nowWithBuffer = new Date(Date.now() + 2000).toISOString()
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    // Busy history is only a short in-flight guard. It must be shorter than the
    // active-order retry delay or a due run excludes its own provider forever.
    const recentBusyCutoff = new Date(Date.now() - 150 * 1000).toISOString()

    const [
      { data: activeRuns },
      { data: globalStuckRuns },
      { data: pendingEngagementRuns, error: engagementRunsError },
      { data: failedEngagementRuns },
      { data: recentlyBusyRuns },
      { data: recentlyCompletedRuns },
    ] = await Promise.all([
      // 1. Active runs for conflict detection
      supabase
        .from('organic_run_schedule')
        .select('*, engagement_order_item:engagement_order_items(engagement_type, service_id, engagement_order:engagement_orders(link))')
        .eq('status', 'started'),
      // 2. Stuck runs for cleanup
      supabase
        .from('organic_run_schedule')
        .select('id, run_number, started_at, provider_account_id, provider_status, provider_order_id, provider_remains, provider_start_count, quantity_to_send, retry_count')
        .eq('status', 'started')
        .or(`started_at.lt.${tenMinAgo},started_at.is.null`),
      // 3. Pending engagement runs
      supabase
        .from('organic_run_schedule')
        .select(`*, engagement_order_item:engagement_order_items!organic_run_schedule_engagement_order_item_id_fkey!inner(*, service:services(*), engagement_order:engagement_orders!inner(*))`)
        .eq('status', 'pending')
        .not('engagement_order_item_id', 'is', null)
        .lte('scheduled_at', nowWithBuffer)
        .order('last_status_check', { ascending: true, nullsFirst: true })
        .order('scheduled_at', { ascending: true })
        .limit(1000),
      // 4. Failed engagement runs for retry
      supabase
        .from('organic_run_schedule')
        .select(`*, engagement_order_item:engagement_order_items!organic_run_schedule_engagement_order_item_id_fkey(*, service:services(*), engagement_order:engagement_orders(*))`)
        .eq('status', 'failed')
        .lt('retry_count', 99)
        .not('engagement_order_item_id', 'is', null)
        .order('completed_at', { ascending: true })
        .limit(50),
      // 5. Recently busy runs (for cooldown)
      supabase
        .from('organic_run_schedule')
        .select(`provider_account_id, error_message, engagement_order_item:engagement_order_items(engagement_type, engagement_order:engagement_orders(link))`)
        .eq('status', 'pending')
        .gte('last_status_check', recentBusyCutoff)
        .limit(1000),
      // One shared rotation-history read per invocation. Previously this ran
      // once for every due run and multiplied database load during bursts.
      supabase
        .from('organic_run_schedule')
        .select('provider_account_id, engagement_order_item:engagement_order_items(engagement_type, engagement_order:engagement_orders(link))')
        .eq('status', 'completed')
        .not('provider_account_id', 'is', null)
        .gte('completed_at', new Date(Date.now() - 5 * 60 * 1000).toISOString())
        .limit(2000),
    ])

    // ==========================================
    // STEP 0: GLOBAL CLEANUP (stuck runs)
    // ==========================================
    if (globalStuckRuns && globalStuckRuns.length > 0) {
      console.log(`🧹 Cleaning ${globalStuckRuns.length} stuck runs`)
      // Batch cleanup in parallel
      const cleanupPromises = globalStuckRuns.map((stuck: any) => {
        const startedTime = stuck.started_at ? new Date(stuck.started_at).getTime() : Date.now() - 11 * 60 * 1000
        const ageMin = Math.round((Date.now() - startedTime) / 60000)
        
        if (!stuck.provider_order_id) {
          return supabase.from('organic_run_schedule').update({
            status: 'pending', started_at: null, provider_account_id: null,
            error_message: `Ghost run reverted after ${ageMin}min`,
          }).eq('id', stuck.id)
        } else {
          // SCAM GUARD: if provider didn't deliver anything (remains == full qty, or start_count null & remains == qty),
          // mark as failed so the scheduler retries on a backup provider instead of silently "completing" a fake order.
          const qty = stuck.quantity_to_send || 0
          const remains = typeof stuck.provider_remains === 'number' ? stuck.provider_remains : null
          const startCount = typeof stuck.provider_start_count === 'number' ? stuck.provider_start_count : null
          const deliveredZero = remains !== null && qty > 0 && remains >= qty && (startCount === null || startCount === 0)
          const isTerminal = isTerminalProviderStatus(stuck.provider_status)
          const isActive = isActiveProviderStatus(stuck.provider_status)
          const retryCount = stuck.retry_count || 0

          if (deliveredZero && isActive && ageMin < 45) {
            return null
          }

          if (deliveredZero && !isTerminal && retryCount < 15) {
            return supabase.from('organic_run_schedule').update({
              status: 'failed', completed_at: new Date().toISOString(),
              error_message: `Auto-retry after ${ageMin}min: provider returned ${stuck.provider_status || 'unknown'} with 0 delivered (remains=${remains}/${qty})`,
            }).eq('id', stuck.id)
          }

          if (!isTerminal && isActive) {
            return null
          }

          return supabase.from('organic_run_schedule').update({
            status: 'completed', completed_at: new Date().toISOString(),
            provider_status: stuck.provider_status || 'Stale',
            error_message: `Auto-completed after ${ageMin}min (status: ${stuck.provider_status || 'unknown'})`,
          }).eq('id', stuck.id)
        }
      })
      await Promise.all(cleanupPromises.filter(Boolean))
      console.log(`✅ Cleaned ${globalStuckRuns.length} stuck runs`)
    }

    // ==========================================
    // STEP 1: Process ENGAGEMENT ORDER runs
    // ==========================================
    console.log(`\n--- Processing Engagement Order Runs ---`)

    if (engagementRunsError) {
      console.error('Error fetching engagement runs:', engagementRunsError)
    }
    console.log(`📥 Fetched ${pendingEngagementRuns?.length || 0} raw pending engagement runs from DB`)

    // PRE-FILTER: Remove paused/cancelled
    const activeEngagementRuns = (pendingEngagementRuns || []).filter((run: any) => {
      const orderStatus = run.engagement_order_item?.engagement_order?.status
      const itemStatus = run.engagement_order_item?.status
      if (orderStatus === 'paused' || orderStatus === 'cancelled') return false
      if (itemStatus === 'paused' || itemStatus === 'cancelled') return false
      return true
    })

    // Fairness: give each item's earliest due run a chance before taking more runs from the same item
    const itemRunCount = new Map<string, number>()
    const MAX_CONCURRENT_PER_ITEM = 1
    const executionProviderMap = new Map<string, Set<string>>()
    // Track link+type combos where ALL providers returned "active order" — only skip same type
    const activeOrderLinkTypes = new Set<string>()

    const pendingRunsLimitedPerItem = activeEngagementRuns.filter((run: any) => {
      const itemId = run.engagement_order_item_id
      const count = itemRunCount.get(itemId) || 0
      if (count < MAX_CONCURRENT_PER_ITEM) {
        itemRunCount.set(itemId, count + 1)
        return true
      }
      return false
    })

    // PRE-FILTER failed runs
    const activeFailedRuns = (failedEngagementRuns || []).filter((run: any) => {
      const orderStatus = run.engagement_order_item?.engagement_order?.status
      const itemStatus = run.engagement_order_item?.status
      if (orderStatus === 'cancelled' || orderStatus === 'paused') return false
      if (itemStatus === 'cancelled' || itemStatus === 'paused') return false
      return true
    })

    const retryableFailedRuns = activeFailedRuns.filter((run: any) => {
      if (!run.provider_order_id) return true
      return isTerminalProviderStatus(run.provider_status)
    })

    const retryRunsLimitedPerItem = retryableFailedRuns.filter((run: any) => {
      const itemId = run.engagement_order_item_id
      const count = itemRunCount.get(itemId) || 0
      if (count < MAX_CONCURRENT_PER_ITEM) {
        itemRunCount.set(itemId, count + 1)
        return true
      }
      return false
    })

    const isDeprioritizedBusyRun = (run: any) => {
      const message = (run.error_message || '').toLowerCase()
      const lastCheck = run.last_status_check ? new Date(run.last_status_check).getTime() : 0
      const cooldownIsFresh = Date.now() - lastCheck < ACTIVE_ORDER_RETRY_MS
      return cooldownIsFresh && (message.includes('[postponed] all providers busy') ||
        message.includes('[batch postponed]') ||
        message.includes('[waiting for merge]') ||
        message.includes('active order on link'))
    }

    const allEngagementRuns = [...pendingRunsLimitedPerItem, ...retryRunsLimitedPerItem].sort((a: any, b: any) => {
      const aBusy = isDeprioritizedBusyRun(a) ? 1 : 0
      const bBusy = isDeprioritizedBusyRun(b) ? 1 : 0
      if (aBusy !== bBusy) return aBusy - bBusy

      const aTime = new Date(a.scheduled_at || 0).getTime()
      const bTime = new Date(b.scheduled_at || 0).getTime()
      return aTime - bTime
    })
    console.log(`Processing ${allEngagementRuns.length} runs (${pendingRunsLimitedPerItem.length} pending + ${retryRunsLimitedPerItem.length} retry), total overdue in DB: check query`)

    // PRE-BUILD busy account lookup for recently busy runs (link → Set<accountId>)
    const recentlyBusyByLinkType = new Map<string, Set<string>>()
    if (recentlyBusyRuns && recentlyBusyRuns.length > 0) {
      for (const rbr of recentlyBusyRuns) {
        if (!rbr.provider_account_id) continue
        const err = (rbr.error_message || '').toLowerCase()
        const isBusyError = err.includes('active order') || err.includes('already has an order') || 
          err.includes('wait until') || err.includes('processing previous') || err.includes('in progress')
        if (isBusyError) {
          const rbrLink = normalizeLink(getNestedEngagementOrderLink(rbr.engagement_order_item))
          const rbrType = (rbr.engagement_order_item?.engagement_type || '').toLowerCase().trim()
          const busyKey = `${rbrLink}|${rbrType}`
          if (!recentlyBusyByLinkType.has(busyKey)) recentlyBusyByLinkType.set(busyKey, new Set())
          recentlyBusyByLinkType.get(busyKey)!.add(rbr.provider_account_id)
        }
      }
    }

    // Process each engagement run
    for (const run of allEngagementRuns) {
      // Timeout guard: if we've been running for 50s, stop to avoid edge function timeout
      if (Date.now() - startTime > 50000) {
        shouldContinue = true
        continuationReason = 'engagement-time-slice-exhausted'
        console.log(`⏰ Approaching timeout (${Date.now() - startTime}ms), stopping processing. Remaining runs will be picked up next cycle.`)
        break
      }

      // FAST SKIP: If we already know this link+type has "active order" on all providers, skip immediately
      const runLink = normalizeLink(run.engagement_order_item?.engagement_order?.link)
      const runType = (run.engagement_order_item?.engagement_type || '').toLowerCase()
      const linkTypeKey = `${runLink}|${runType}`
      if (runLink && activeOrderLinkTypes.has(linkTypeKey)) {
        const newScheduledAt = new Date(Date.now() + ACTIVE_ORDER_RETRY_MS).toISOString()
        await supabase.from('organic_run_schedule').update({
          status: 'pending',
          scheduled_at: newScheduledAt,
          error_message: `[Postponed] Active order on link for ${runType}`,
          last_status_check: new Date().toISOString(),
        }).eq('id', run.id)
        skipped++
        continue
      }

      const isRetry = run.status === 'failed'
      const item = run.engagement_order_item
      if (!item) {
        await supabase.from('organic_run_schedule').update({
          status: 'failed', error_message: 'Missing engagement order item',
        }).eq('id', run.id)
        failed++
        continue
      }

      const currentType = item.engagement_type?.toLowerCase()
      const engagementOrderStatus = item.engagement_order?.status
      const itemStatus = item.status
      
      // CANCELLED = PERMANENT
      if (engagementOrderStatus === 'cancelled') {
        await supabase.from('organic_run_schedule').update({
          status: 'cancelled', error_message: 'Order cancelled by user',
          completed_at: new Date().toISOString(),
        }).eq('id', run.id)
        skipped++
        continue
      }
      if (itemStatus === 'cancelled') {
        await supabase.from('organic_run_schedule').update({
          status: 'cancelled', error_message: 'Item cancelled by user',
          completed_at: new Date().toISOString(),
        }).eq('id', run.id)
        skipped++
        continue
      }
      
      // PAUSED = TEMPORARY
      if (engagementOrderStatus === 'paused' || itemStatus === 'paused') {
        skipped++
        continue
      }

      // 🛡️ OVER-DELIVERY GUARD: Ensure cumulative sent quantity never exceeds item.quantity
      // Tracks BOTH what we asked AND what the platform actually shows delivered
      // (via provider_start_count deltas) so panel over-delivery also counts toward target.
      try {
        const orderedQty = Number(item.quantity || 0)
        if (orderedQty > 0) {
          const { data: sentRows } = await supabase
            .from('organic_run_schedule')
            .select('quantity_to_send,status,provider_start_count,run_number')
            .eq('engagement_order_item_id', item.id)
            .in('status', ['completed', 'started'])
          const askedSent = (sentRows || []).reduce(
            (s: number, r: any) => s + Number(r.quantity_to_send || 0), 0)

          // Compute REAL platform delivery from start_count deltas
          const startCounts = (sentRows || [])
            .map((r: any) => Number(r.provider_start_count))
            .filter((n: number) => Number.isFinite(n) && n > 0)
          let actualDelivered = 0
          if (startCounts.length > 0 && Number.isFinite(Number(run.provider_start_count)) && Number(run.provider_start_count) > 0) {
            const firstSC = Math.min(...startCounts)
            const currentSC = Number(run.provider_start_count)
            actualDelivered = Math.max(0, currentSC - firstSC)
          }

          // Use the larger of the two so panel over-delivery counts
          const alreadySent = Math.max(askedSent, actualDelivered)
          const remaining = orderedQty - alreadySent
          if (remaining <= 0) {
            // Target met (or exceeded via over-delivery) — cancel ALL remaining pending runs.
            // IMPORTANT: error_message MUST start with "Target met" so the UI helper
            // (isTargetMetAutoCompleted) treats these as Completed, not Cancelled.
            const publicDelta = actualDelivered // platform-observed delta
            const observed = Math.max(askedSent, actualDelivered)
            const marker = `Target met (asked=${askedSent}, observed=${observed}, public_delta=${publicDelta}, target=${orderedQty}) — cancelling remaining runs`
            await supabase.from('organic_run_schedule').update({
              status: 'cancelled',
              error_message: marker,
              completed_at: new Date().toISOString(),
            }).eq('engagement_order_item_id', item.id).eq('status', 'pending')
            await supabase.from('engagement_order_items').update({
              status: 'completed', updated_at: new Date().toISOString(),
            }).eq('id', item.id).neq('status', 'completed')
            skipped++
            console.log(`🛡️ Item ${item.id} target met — ${marker}`)
            continue
          }
          if (run.quantity_to_send > remaining) {
            console.log(`🛡️ Capping run #${run.run_number} qty ${run.quantity_to_send} → ${remaining} (asked=${askedSent}, actual=${actualDelivered}, target=${orderedQty})`)
            await supabase.from('organic_run_schedule').update({
              quantity_to_send: remaining,
            }).eq('id', run.id)
            run.quantity_to_send = remaining
          }
        }
      } catch (capErr) {
        console.error('Over-delivery guard error:', capErr)
      }

      if (!item.service) {
        // FALLBACK: Try bundle
        const bundleId = item.engagement_order?.bundle_id
        if (bundleId) {
          const { data: bundleItem } = await supabase
            .from('bundle_items')
            .select('service_id, service:services(*)')
            .eq('bundle_id', bundleId)
            .eq('engagement_type', item.engagement_type)
            .not('service_id', 'is', null)
            .limit(1).single()
          
          if (bundleItem?.service) {
            item.service = bundleItem.service
            await supabase.from('engagement_order_items')
              .update({ service_id: bundleItem.service_id })
              .eq('id', item.id)
          }
        }
        
        if (!item.service) {
          const retryCount = (run.retry_count || 0) + 1
          if (retryCount >= MAX_RUN_RETRIES) {
            await supabase.from('organic_run_schedule').update({
              status: 'failed', error_message: `Service not found after ${MAX_RUN_RETRIES} retries`,
              retry_count: 99,
            }).eq('id', run.id)
            failed++
          } else {
            await supabase.from('organic_run_schedule').update({
              status: 'failed', error_message: 'Service not found - will retry',
              retry_count: retryCount,
            }).eq('id', run.id)
            skipped++
          }
          continue
        }
      }

      // Platform mismatch detection
      const orderLink = item.engagement_order?.link || ''
      const linkPlatform = detectPlatformFromLink(orderLink)
      const servicePlatform = detectPlatformFromService(item.service.name || '')
      
      if (linkPlatform && servicePlatform && linkPlatform !== servicePlatform) {
        await supabase.from('organic_run_schedule').update({
          status: 'failed',
          error_message: `BLOCKED: Platform mismatch - ${linkPlatform} link cannot use ${servicePlatform} service`,
          completed_at: new Date().toISOString(), retry_count: 99,
        }).eq('id', run.id)
        failed++
        continue
      }

      const sameLink = normalizeLink(orderLink)
      const currentServiceId = item.service?.id
      const sameLinkNormalized = sameLink
      const currentTypeNormalized = (currentType || '').toLowerCase().trim()
      const localExecutionKey = `${sameLinkNormalized}|${currentTypeNormalized}`
      
      // Build busy account list
      const busyAccountIds: string[] = []
      const hardBusyAccountIds: string[] = []
      const addBusyAccount = (accountId?: string | null, hard = false) => {
        if (!accountId) return
        if (!busyAccountIds.includes(accountId)) busyAccountIds.push(accountId)
        if (hard && !hardBusyAccountIds.includes(accountId)) hardBusyAccountIds.push(accountId)
      }
      
      // From execution-level tracking
      const usedProvidersForKey = executionProviderMap.get(localExecutionKey) || new Set<string>()
      for (const usedId of usedProvidersForKey) {
        addBusyAccount(usedId)
      }
      
      // From pre-fetched recently busy runs
      const busyForLinkType = recentlyBusyByLinkType.get(localExecutionKey)
      if (busyForLinkType) {
        for (const accId of busyForLinkType) {
          addBusyAccount(accId)
        }
      }

      // HARD LOCK: any provider account that still holds a non-terminal provider
      // order on this exact (link, type) is unavailable — never reused, never
      // included in any fallback.
      const providersBusyOnLink = await getProvidersBusyOnLink(
        supabase, sameLinkNormalized, currentTypeNormalized, run.id
      )
      for (const accId of providersBusyOnLink) {
        addBusyAccount(accId, true)
      }
      if (providersBusyOnLink.size > 0) {
        console.log(`🔒 ${providersBusyOnLink.size} provider(s) locked on this link+type (active provider order)`)
      }



      // FALLBACK: If this run already failed/cancelled on a provider, exclude it on retry
      // so the system tries a backup provider instead of repeating the same one.
      if (isRetry && run.provider_account_id) {
        if (!busyAccountIds.includes(run.provider_account_id)) {
          addBusyAccount(run.provider_account_id)
          console.log(`🔁 Retry run #${run.run_number}: excluding previous provider ${run.provider_account_name || run.provider_account_id} (failed/cancelled), will try backup`)
        }
      }

      // FALLBACK: Exclude every provider already attempted for this run
      // (tracked in provider_response.tried_providers by check-order-status).
      const triedProviders: string[] = isRetry && Array.isArray(run.provider_response?.tried_providers)
        ? run.provider_response.tried_providers : []
      for (const tp of triedProviders) {
        addBusyAccount(tp)
      }

      // FALLBACK: Also exclude any provider_account_id that already failed/cancelled
      // for this SAME engagement_order_item (prevents same-provider repeat across retries).
      try {
        // Only consider RECENT cancellations (last 60 min). Older cancellations
        // shouldn't permanently block a provider — the issue is usually transient.
        const sixtyMinAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        const { data: priorFailedForItem } = await supabase
          .from('organic_run_schedule')
          .select('id, provider_account_id, error_message, provider_status, status, completed_at')
          .eq('engagement_order_item_id', item.id)
          .in('status', ['failed', 'cancelled'])
          .not('provider_account_id', 'is', null)
          .gte('completed_at', sixtyMinAgo)
          .limit(50)
        if (priorFailedForItem) {
          for (const pr of priorFailedForItem as any[]) {
            const ps = (pr.provider_status || '').toLowerCase()
            const em = (pr.error_message || '').toLowerCase()
            const wasCancelled =
              ps.includes('cancel') || ps.includes('refund') ||
              em.includes('cancel') || em.includes('refund')
            if (wasCancelled && pr.id !== run.id && pr.provider_account_id && !busyAccountIds.includes(pr.provider_account_id)) {
              addBusyAccount(pr.provider_account_id)
            }
          }
        }
      } catch (_e) { /* non-fatal */ }

      // IMPORTANT: Do not block a provider for this item just because a different
      // engagement type in the same order had a cancelled/refunded run earlier.
      // Shares/Saves often have only one mapped provider, and cross-type exclusions
      // can incorrectly leave zero accounts to try, causing endless postpones.
      
      // From active (started) runs for same link+type
      const startedRunsForLink = (activeRuns || []).filter((r: any) => {
        const runLink = normalizeLink(r.engagement_order_item?.engagement_order?.link)
        const runType = (r.engagement_order_item?.engagement_type || '').toLowerCase()
        return runLink === sameLink && runType === currentTypeNormalized
      })
      
      // ROUND-ROBIN: Prefer a different provider after a recent completion,
      // but do NOT hard-block the just-used provider.
      // Otherwise next run can get stuck even after the previous one is completed.
      const recentCompletedAccountIds = new Set<string>()
      if (recentlyCompletedRuns) {
        for (const rcr of recentlyCompletedRuns) {
          const rcrLink = normalizeLink(getNestedEngagementOrderLink(rcr.engagement_order_item))
          const rcrType = (rcr.engagement_order_item?.engagement_type || '').toLowerCase()
          if (rcrLink === sameLink && rcrType === currentTypeNormalized && rcr.provider_account_id) {
            recentCompletedAccountIds.add(rcr.provider_account_id)
          }
        }
      }
      
      if (startedRunsForLink && startedRunsForLink.length > 0) {
        for (const stuckRun of startedRunsForLink) {
          const terminalStatuses = ['Completed', 'Complete', 'Partial', 'Refunded', 'Canceled', 'Cancelled', 'Error', 'Failed', 'Success', 'Refund', 'Canscelled']
          const isTerminal = stuckRun.provider_status && terminalStatuses.includes(stuckRun.provider_status)
          const hasNoRemains = typeof stuckRun.provider_remains === 'number' && stuckRun.provider_remains <= 0 && !!stuckRun.provider_order_id
          
          const startedAt = new Date(stuckRun.started_at || 0)
          const runAge = Math.round((Date.now() - startedAt.getTime()) / 1000)
          
          if (isTerminal || hasNoRemains) {
            // SCAM GUARD: terminal status but 0 actually delivered → retry instead of complete
            const qty = stuckRun.quantity_to_send || 0
            const remains = typeof stuckRun.provider_remains === 'number' ? stuckRun.provider_remains : null
            const startCount = typeof stuckRun.provider_start_count === 'number' ? stuckRun.provider_start_count : null
            const deliveredZero = !hasNoRemains && remains !== null && qty > 0 && remains >= qty && (startCount === null || startCount === 0)
            const retryCount = stuckRun.retry_count || 0
            if (deliveredZero && retryCount < 15) {
              console.log(`⚠️ Auto-retry run #${stuckRun.run_number}: provider ${stuckRun.provider_status} with 0 delivered`)
              await supabase.from('organic_run_schedule').update({
                status: 'failed', completed_at: new Date().toISOString(),
                error_message: `Auto-retry: provider ${stuckRun.provider_status} with 0 delivered (remains=${remains}/${qty})`,
              }).eq('id', stuckRun.id)
            } else {
              console.log(`🔄 Auto-completing run #${stuckRun.run_number} (${hasNoRemains ? 'no remains left' : `terminal: ${stuckRun.provider_status}`})`)
              await supabase.from('organic_run_schedule').update({
                status: 'completed', completed_at: new Date().toISOString(),
                error_message: hasNoRemains
                  ? `Auto-completed (provider remains reached 0)`
                  : `Auto-completed (status: ${stuckRun.provider_status})`,
              }).eq('id', stuckRun.id)
            }
          } else if (stuckRun.provider_account_id) {
            if (hasUncertainDispatch(stuckRun)) {
              console.log(`🛑 Holding run #${stuckRun.run_number}: provider dispatch uncertain, skipping resend until manual/provider confirmation`)
              skipped++
              continue
            }

            if (!stuckRun.provider_order_id && runAge > 60) {
              await supabase.from('organic_run_schedule').update({
                status: 'pending', started_at: null, provider_account_id: null,
                error_message: `Ghost run reverted (no provider order after ${runAge}s)`,
              }).eq('id', stuckRun.id)
              continue
            }
            
            if (!stuckRun.provider_order_id && runAge <= 60) {
              if (!busyAccountIds.includes(stuckRun.provider_account_id)) {
                addBusyAccount(stuckRun.provider_account_id, true)
              }
              continue
            }
            
            // A provider order that already has an ID must not become a permanent
            // in-app hard lock. Some providers leave an order in Pending/Processing
            // for a long time (or never send a terminal status), which previously
            // made the only mapped account unavailable forever. Keep this as a soft
            // preference: when no alternative account exists the scheduler will ask
            // the provider again and let its API decide whether another order is
            // currently allowed. A real "active order" response is postponed below.
            if (!busyAccountIds.includes(stuckRun.provider_account_id)) {
              addBusyAccount(stuckRun.provider_account_id)
            }
          }
        }
      }

      // ==========================================
      // OPTIMIZED: Use cached mapping lookup
      // ==========================================
      const availableAccounts = await mappingCache.getForService(
        supabase, item.service.id, busyAccountIds, executionId
      )
      
      // Default provider fallback
      let defaultProvider: ProviderAccount | null = null
      if (item.service.provider_id) {
        // FIX: provider_account_id column is UUID. Resolve text provider_id → matching
        // provider_accounts row (UUID). If none exists, skip the fallback to avoid
        // "invalid input syntax for type uuid" errors that block all runs.
        const { data: acct } = await supabase
          .from('provider_accounts').select('*')
          .eq('provider_id', item.service.provider_id)
          .eq('is_active', true)
          .order('priority', { ascending: false })
          .limit(1).maybeSingle()

        if (acct && acct.api_key?.trim() && isValidHttpUrl(acct.api_url) &&
            !busyAccountIds.includes(acct.id) &&
            !availableAccounts.some(a => a.account.id === acct.id)) {
          defaultProvider = {
            id: acct.id, provider_id: acct.provider_id, name: acct.name,
            api_key: acct.api_key, api_url: acct.api_url,
            priority: 999, is_active: acct.is_active, last_used_at: acct.last_used_at
          }
        }
      }
      
      const accountsToTry: { account: ProviderAccount; providerServiceId: string; minQuantity: number; isBackup?: boolean }[] = [...availableAccounts]
      accountsToTry.sort((a, b) => {
        const aRecent = recentCompletedAccountIds.has(a.account.id) ? 1 : 0
        const bRecent = recentCompletedAccountIds.has(b.account.id) ? 1 : 0
        return aRecent - bRecent
      })
      if (defaultProvider && !accountsToTry.some(a => a.account.id === defaultProvider!.id)) {
        accountsToTry.push({
          account: defaultProvider,
          providerServiceId: item.service.provider_service_id,
          minQuantity: Number(item.service.min_quantity || 0),
        })
      }
      
      if (accountsToTry.length === 0) {
        // Soft exclusions (recent attempt/LRU history) must never turn into an
        // endless "all providers busy" loop. Re-open every mapped account except
        // providers with a real active order on this exact link+type.
        const fallbackAccounts = await mappingCache.getForService(
          supabase, item.service.id, hardBusyAccountIds, executionId
        )

        if (fallbackAccounts.length > 0) {
          console.log(`⚠️ Run #${run.run_number}: soft busy filters removed all providers; forcing retry on ${fallbackAccounts.length} mapped provider(s)`)
          accountsToTry.push(...fallbackAccounts)
        }
      }

      if (accountsToTry.length === 0) {
        if (mappingCache.hasAnyForService(item.service.id)) {
          // POSTPONE: All providers busy — push scheduled_at forward so we don't waste cycles
          const postponeMs = ACTIVE_ORDER_RETRY_MS
          const newScheduledAt = new Date(Date.now() + postponeMs).toISOString()
          await supabase.from('organic_run_schedule').update({
            scheduled_at: newScheduledAt,
            error_message: `Waiting: all providers busy on this link`,
            last_status_check: new Date().toISOString(),
          }).eq('id', run.id)
          skipped++
          console.log(`⏳ Run #${run.run_number} postponed ${postponeMs / 60000}min (all providers pre-filtered as busy)`)
          results.push({ run_id: run.id, run_number: run.run_number, type: item.engagement_type,
            success: false, skipped: true, reason: `All providers busy - postponed ${postponeMs / 60000}min` })
        } else {
          const mappingError = `No active provider mapping/account for service ${item.service.id} (${item.service.name || item.engagement_type})`
          console.error(`❌ ${mappingError} [${executionId}]`)
          await supabase.from('organic_run_schedule').update({
            status: 'failed', error_message: mappingError, last_status_check: new Date().toISOString(),
          }).eq('id', run.id)
          failed++
        }
        continue
      }

      // Quantity handling — pick the LOWEST-min provider first so small runs aren't rejected.
      // If every provider minimum is still above the scheduled qty, merge with future
      // pending runs of the same item so shares/saves do not get stuck forever.
      const originalQty = run.quantity_to_send
      let effectiveQty = originalQty
      accountsToTry.sort((a, b) => {
        const aFits = (a.minQuantity || 0) <= effectiveQty ? 0 : 1
        const bFits = (b.minQuantity || 0) <= effectiveQty ? 0 : 1
        if (aFits !== bFits) return aFits - bFits
        return (a.minQuantity || 0) - (b.minQuantity || 0)
      })
      const smallestAccountMin = accountsToTry.reduce((min, entry) => {
        const candidateMin = Number(entry.minQuantity || 0)
        if (candidateMin <= 0) return min
        if (min <= 0) return candidateMin
        return Math.min(min, candidateMin)
      }, 0)
      let quantityToSend = effectiveQty

      if (smallestAccountMin > 0 && effectiveQty < smallestAccountMin) {
        const { data: futurePendingRuns } = await supabase
          .from('organic_run_schedule')
          .select('id, run_number, quantity_to_send')
          .eq('engagement_order_item_id', item.id)
          .eq('status', 'pending')
          .gt('run_number', run.run_number)
          .order('run_number', { ascending: true })

        let combinedQty = effectiveQty
        const runsToMerge: string[] = []
        for (const pendingRun of futurePendingRuns || []) {
          combinedQty += Number(pendingRun.quantity_to_send || 0)
          runsToMerge.push(pendingRun.id)
          if (combinedQty >= smallestAccountMin) break
        }

        if (combinedQty >= smallestAccountMin && runsToMerge.length > 0) {
          await supabase.from('organic_run_schedule').update({
            quantity_to_send: combinedQty,
            base_quantity: combinedQty,
            error_message: `Merged ${runsToMerge.length + 1} runs to meet provider min ${smallestAccountMin}`,
            last_status_check: new Date().toISOString(),
          }).eq('id', run.id)

          await supabase.from('organic_run_schedule').update({
            status: 'cancelled',
            completed_at: new Date().toISOString(),
            error_message: `Merged into run #${run.run_number} to meet provider min ${smallestAccountMin}`,
            last_status_check: new Date().toISOString(),
          }).in('id', runsToMerge)

          effectiveQty = combinedQty
          quantityToSend = combinedQty
          run.quantity_to_send = combinedQty
          run.base_quantity = combinedQty
          accountsToTry.sort((a, b) => {
            const aFits = (a.minQuantity || 0) <= effectiveQty ? 0 : 1
            const bFits = (b.minQuantity || 0) <= effectiveQty ? 0 : 1
            if (aFits !== bFits) return aFits - bFits
            return (a.minQuantity || 0) - (b.minQuantity || 0)
          })
          console.log(`🧩 Run #${run.run_number} merged to ${combinedQty} for ${item.engagement_type} to satisfy provider min ${smallestAccountMin}`)
        } else {
          // No future runs to merge with — bump quantity up to provider minimum
          // so the order actually places instead of being postponed forever.
          effectiveQty = smallestAccountMin
          quantityToSend = smallestAccountMin
          run.quantity_to_send = smallestAccountMin
          run.base_quantity = smallestAccountMin
          await supabase.from('organic_run_schedule').update({
            quantity_to_send: smallestAccountMin,
            base_quantity: smallestAccountMin,
            error_message: `Bumped ${originalQty} → ${smallestAccountMin} (provider min, no future runs to merge)`,
            last_status_check: new Date().toISOString(),
          }).eq('id', run.id)
          accountsToTry.sort((a, b) => {
            const aFits = (a.minQuantity || 0) <= effectiveQty ? 0 : 1
            const bFits = (b.minQuantity || 0) <= effectiveQty ? 0 : 1
            if (aFits !== bFits) return aFits - bFits
            return (a.minQuantity || 0) - (b.minQuantity || 0)
          })
          console.log(`⬆️ Run #${run.run_number} bumped ${originalQty} → ${smallestAccountMin} to satisfy provider min (no mergeable runs)`)
        }

      }

      console.log(`🔄 Run #${run.run_number}: ${effectiveQty} ${item.engagement_type}, trying ${accountsToTry.length} accounts`)

      const currentStatus = isRetry ? 'failed' : 'pending'
      let runClaimed = false
      const triedProviderIds: string[] = []

      // Try each account
      let success = false
      let lastError: string | null = null
      let providerOrderId: string | null = null
      let providerResult: any = null
      let successAccount: ProviderAccount | null = null
      let verifiedStatus: string | null = null
      let verifiedRemains: number | null = null
      let verifiedStartCount: number | null = null
      let verifiedCharge: number | null = null
      let verifiedLastStatusCheck: string | null = null
      
      let lastPrimaryName: string | null = null
      for (const { account: selectedAccount, providerServiceId, minQuantity: accountMinQty, isBackup } of accountsToTry) {
        if (!isBackup) lastPrimaryName = selectedAccount.name
        // NEVER boost quantity above what was scheduled — that causes over-delivery
        // (e.g. scheduled 112 views but provider min is 500 → user sees 500+ delivered).
        // Instead, skip providers whose min exceeds the scheduled qty and try the next one.
        if (accountMinQty && accountMinQty > effectiveQty) {
          lastError = `Provider ${selectedAccount.name} min ${accountMinQty} > scheduled ${effectiveQty}, skipping to avoid over-delivery`
          console.log(`⏭️ ${lastError}`)
          continue
        }
        quantityToSend = effectiveQty
        // PRE-CHECK: Cancel check
        {
          const { data: freshItem } = await supabase
            .from('engagement_order_items')
            .select('status, engagement_order:engagement_orders(status)')
            .eq('id', item.id).maybeSingle()
          
          const freshOrderStatus = (freshItem as any)?.engagement_order?.status
          const freshItemStatus = freshItem?.status
          
          if (freshOrderStatus === 'cancelled' || freshItemStatus === 'cancelled') {
            await supabase.from('organic_run_schedule').update({
              status: 'cancelled', error_message: 'Cancelled before provider send',
              completed_at: new Date().toISOString(),
            }).eq('id', run.id)
            skipped++
            break
          }
        }

        // Balance check
        const { hasBalance, balance: providerBalance } = await checkProviderBalance(selectedAccount)
        if (!hasBalance) {
          lastError = `Provider ${selectedAccount.name} has no balance`
          continue
        }
        const estimatedCost = quantityToSend * 0.0001
        if (providerBalance >= 0 && providerBalance < estimatedCost) {
          lastError = `Provider ${selectedAccount.name} balance too low (${providerBalance})`
          continue
        }

        if (!isValidHttpUrl(selectedAccount.api_url)) {
          lastError = `Provider ${selectedAccount.name} has invalid API URL`
          continue
        }
        
        // RE-CHECK INSIDE THE LOCK: never dispatch to a provider that picked up an
        // active order on this link+type since the candidate list was built.
        const freshBusy = await getProvidersBusyOnLink(
          supabase, sameLinkNormalized, currentTypeNormalized, run.id
        )
        if (freshBusy.has(selectedAccount.id)) {
          lastError = `Provider ${selectedAccount.name} already has an active order on this link`
          console.log(`🔒 Skipping ${selectedAccount.name}: ${lastError}`)
          continue
        }

        triedProviderIds.push(selectedAccount.id)

        const rotationLockKey = `${sameLinkNormalized}|${currentTypeNormalized}`

        if (!runClaimed) {
          const baseUpdates: Record<string, any> = {
            status: 'started',
            started_at: new Date().toISOString(),
            error_message: `Trying ${selectedAccount.name}...`,
            retry_count: (run.retry_count || 0) + (isRetry ? 1 : 0),
            provider_order_id: null,
            provider_status: null,
            provider_response: null,
            provider_account_id: selectedAccount.id,
            provider_account_name: selectedAccount.name,
            last_status_check: new Date().toISOString(),
          }

          let claimResult = await claimRunLock({
            supabase,
            runId: run.id,
            expectedStatus: currentStatus,
            updates: { ...baseUpdates, rotation_lock_key: rotationLockKey },
          })

          // Backends without the rotation_lock_key column keep working.
          if (claimResult.error && /rotation_lock_key/i.test(claimResult.error.message || '')) {
            claimResult = await claimRunLock({
              supabase, runId: run.id, expectedStatus: currentStatus, updates: baseUpdates,
            })
          }

          const claimError = claimResult.error
          const lockAcquired = claimResult.locked

          if (claimError) {
            const msg = claimError.message || 'unknown error'
            // Unique violation on (link, type, provider_account) → another worker
            // claimed this provider for this link first. Skip to next candidate.
            if (claimError.code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
              lastError = `Provider ${selectedAccount.name} claimed concurrently for this link`
              console.log(`🔒 ${lastError}, trying next provider`)
              continue
            }
            console.error(`❌ Failed to claim run lock for ${run.id}:`, claimError)
            lastError = `Run claim failed: ${msg}`
            break
          }

          if (!lockAcquired) {
            console.log(`⏭️ Run #${run.run_number} already claimed by another execution, skipping duplicate send`)
            skipped++
            lastError = null
            break
          }

          runClaimed = true
        } else {
          const { error: switchError } = await supabase.from('organic_run_schedule').update({
            error_message: `Trying ${selectedAccount.name}...`,
            provider_account_id: selectedAccount.id,
            provider_account_name: selectedAccount.name,
            provider_order_id: null,
            provider_status: null,
            provider_response: null,
            last_status_check: new Date().toISOString(),
          }).eq('id', run.id).eq('status', 'started')

          if (switchError) {
            const msg = switchError.message || ''
            if ((switchError as any).code === '23505' || /duplicate key|unique constraint/i.test(msg)) {
              lastError = `Provider ${selectedAccount.name} claimed concurrently for this link`
              console.log(`🔒 ${lastError}, trying next provider`)
              continue
            }
            console.error(`❌ Failed to switch provider on run ${run.id}:`, switchError)
            lastError = `Provider switch failed: ${msg || 'unknown error'}`
            break
          }
        }


        try {
          const formData = new URLSearchParams()
          formData.append('key', selectedAccount.api_key)
          formData.append('action', 'add')
          formData.append('service', providerServiceId)
          formData.append('link', item.engagement_order.link)
          // OVER-DELIVERY GUARD: if admin configured this provider to over-deliver (e.g. 2.0 = sends 2x),
          // divide the scheduled qty so the user's video ultimately receives the correct amount.
          const deliveryMultiplier = Math.max(Number(selectedAccount.delivery_multiplier || 1), 0.5)
          let adjustedQty = quantityToSend
          if (deliveryMultiplier > 1) {
            adjustedQty = Math.max(1, Math.round(quantityToSend / deliveryMultiplier))
            console.log(`📉 Over-delivery guard: ${selectedAccount.name} multiplier=${deliveryMultiplier}, sending ${adjustedQty} instead of ${quantityToSend}`)
          }
          // Respect provider min even after dividing
          if (accountMinQty && adjustedQty < accountMinQty) {
            adjustedQty = accountMinQty
          }
          formData.append('quantity', adjustedQty.toString())

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 30000)

          const response = await fetch(selectedAccount.api_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString(),
            signal: controller.signal,
          })

          clearTimeout(timeoutId)
          const responseText = await response.text()
          console.log(`Provider response from ${selectedAccount.name}: HTTP ${response.status} ${responseText}`)

          let result
          try { result = JSON.parse(responseText) } catch { result = { error: responseText } }

          if (!response.ok || result.status === 'fail' || result.error) {
            const providerMessage = result.message || result.error || responseText || response.statusText
            lastError = `HTTP ${response.status}: ${typeof providerMessage === 'string' ? providerMessage : JSON.stringify(providerMessage)}`
            if (lastError === null || lastError === undefined) lastError = 'Unknown provider error'
            if (typeof lastError !== 'string') lastError = JSON.stringify(lastError)
            providerResult = result

            // Provider minimums sometimes change without the imported service
            // catalogue being refreshed (for example: "minimal 50"). Learn the
            // real minimum from the response, merge future schedule rows, and
            // retry the consolidated run on the next executor tick.
            const minimumMatch = lastError.match(/(?:minimal|minimum|min(?:imum)?\s+quantity)[^0-9]{0,20}(\d+)/i)
            const reportedMinimum = minimumMatch ? Number(minimumMatch[1]) : 0
            if (reportedMinimum > effectiveQty) {
              const { data: futureMinimumRuns } = await supabase
                .from('organic_run_schedule')
                .select('id, quantity_to_send')
                .eq('engagement_order_item_id', item.id)
                .eq('status', 'pending')
                .gt('run_number', run.run_number)
                .order('run_number', { ascending: true })

              let consolidatedQty = effectiveQty
              const mergedIds: string[] = []
              for (const pendingRun of futureMinimumRuns || []) {
                consolidatedQty += Number(pendingRun.quantity_to_send || 0)
                mergedIds.push(pendingRun.id)
                if (consolidatedQty >= reportedMinimum) break
              }
              consolidatedQty = Math.max(consolidatedQty, reportedMinimum)

              if (mergedIds.length > 0) {
                await supabase.from('organic_run_schedule').update({
                  status: 'cancelled', completed_at: new Date().toISOString(),
                  error_message: `Merged into run #${run.run_number} after provider reported min ${reportedMinimum}`,
                  last_status_check: new Date().toISOString(),
                }).in('id', mergedIds)
              }
              await supabase.from('organic_run_schedule').update({
                quantity_to_send: consolidatedQty, base_quantity: consolidatedQty,
                error_message: `Provider minimum updated ${effectiveQty} → ${reportedMinimum}; consolidated for retry`,
                last_status_check: new Date().toISOString(),
              }).eq('id', run.id)
              effectiveQty = consolidatedQty
              quantityToSend = consolidatedQty
              lastError = `Provider minimum ${reportedMinimum} learned; run consolidated to ${consolidatedQty}`
              console.log(`🧩 Run #${run.run_number}: learned provider min ${reportedMinimum}, consolidated to ${consolidatedQty}`)
              break
            }
            
            const isActiveOrderError = lastError.toLowerCase().includes('active order') || 
              lastError.toLowerCase().includes('wait until order')
            if (isActiveOrderError) {
              await new Promise(resolve => setTimeout(resolve, 200))
              continue
            }
            
            const isTemporaryError = TEMPORARY_ERRORS.some(err => lastError!.toLowerCase().includes(err.toLowerCase()))
            if (isTemporaryError) {
              await new Promise(resolve => setTimeout(resolve, 200))
              continue
            }
            
            const isAccountSpecificError = ACCOUNT_SPECIFIC_ERRORS.some(err => lastError!.toLowerCase().includes(err.toLowerCase()))
            if (isAccountSpecificError) {
              await new Promise(resolve => setTimeout(resolve, 200))
              continue
            }
            
            const isTryNextProviderError = TRY_NEXT_PROVIDER_ERRORS.some(err => lastError!.toLowerCase().includes(err.toLowerCase()))
            if (isTryNextProviderError) {
              await new Promise(resolve => setTimeout(resolve, 200))
              continue
            }
            
            break
          } else {
            providerOrderId = result.order?.toString() || result.id?.toString() || null

            if (!providerOrderId) {
              lastError = 'Provider returned success but no order id'
              providerResult = result
              continue
            }

            const verification = await checkProviderOrderStatusWithRetries({
              apiUrl: selectedAccount.api_url,
              apiKey: selectedAccount.api_key,
              providerOrderId,
              maxAttempts: 3,
              attemptDelayMs: 1500,
            })

            if (!verification.ok) {
              lastError = `Provider order ${providerOrderId} not verified after add: ${verification.error}`
              providerResult = { add: result, verification_error: verification.error, verification_raw: verification.rawText }
              console.log(`⚠️ ${lastError}`)
              continue
            }

            const statusResult = verification.data || {}
            const parsedStartCount = Number.parseInt(statusResult.start_count)
            const parsedRemains = Number.parseInt(statusResult.remains)
            const parsedCharge = Number.parseFloat(statusResult.charge)

            verifiedStatus = statusResult.status || 'Pending'
            verifiedStartCount = Number.isFinite(parsedStartCount) ? parsedStartCount : null
            verifiedRemains = Number.isFinite(parsedRemains) ? parsedRemains : null
            verifiedCharge = Number.isFinite(parsedCharge) ? parsedCharge : null
            verifiedLastStatusCheck = new Date().toISOString()
            providerResult = { add: result, status: statusResult }
            successAccount = selectedAccount
            success = true
            await updateAccountLastUsed(supabase, selectedAccount.id)
            mappingCache.markUsed(item.service.id, selectedAccount.id)
            console.log(`✅ Run #${run.run_number} placed + verified via ${selectedAccount.name}! Order ID: ${providerOrderId}, status: ${verifiedStatus}`)
            if (isBackup) {
              alertFallbackUsed(lastPrimaryName, selectedAccount, item.service?.name || item.engagement_type || 'unknown').catch(() => {})
            }
            break
          }
        } catch (fetchError: any) {
          const uncertainDispatchAt = new Date().toISOString()
          const uncertainMessage = `Network error after provider request. [Dispatch uncertain] Verify provider before retrying: ${fetchError.message || 'Unknown'}`

          await supabase.from('organic_run_schedule').update({
            status: 'started',
            started_at: run.started_at || uncertainDispatchAt,
            completed_at: null,
            error_message: uncertainMessage,
            provider_response: {
              uncertain_dispatch: true,
              stage: 'provider_add_request',
              fetch_error: fetchError.message || 'Unknown',
              happened_at: uncertainDispatchAt,
            },
            last_status_check: uncertainDispatchAt,
          }).eq('id', run.id).eq('status', 'started')

          lastError = null
          console.error(`🚨 Dispatch uncertain for run #${run.run_number}; resend blocked to avoid duplicate provider order`, fetchError)
          skipped++
          break
        }
      }

      // Update run based on result
      if (success && providerOrderId && successAccount) {
        const { data: freshItemPostSend } = await supabase
          .from('engagement_order_items')
          .select('status, engagement_order:engagement_orders(status)')
          .eq('id', item.id).maybeSingle()
        
        const postSendOrderStatus = (freshItemPostSend as any)?.engagement_order?.status
        const postSendItemStatus = freshItemPostSend?.status
        
        if (postSendOrderStatus === 'cancelled' || postSendItemStatus === 'cancelled') {
          await supabase.from('organic_run_schedule').update({
            status: 'cancelled', provider_order_id: providerOrderId,
            provider_response: providerResult,
            provider_account_id: successAccount.id, provider_account_name: successAccount.name,
            provider_status: verifiedStatus,
            error_message: `Order cancelled during send — provider order ${providerOrderId} may need manual cancellation`,
            completed_at: new Date().toISOString(), last_status_check: new Date().toISOString(),
          }).eq('id', run.id)
          skipped++
          continue
        }
        
        // Update run + item + order in parallel
        const providerDeliveredAll = verifiedRemains === 0 && !isFailedProviderStatus(verifiedStatus)
        const providerIsTerminal = isTerminalProviderStatus(verifiedStatus) || providerDeliveredAll

        const updatePromises = [
          supabase.from('organic_run_schedule').update({
            provider_order_id: providerOrderId, provider_response: providerResult,
            error_message: null, provider_account_id: successAccount.id,
            provider_account_name: successAccount.name, provider_status: verifiedStatus,
            provider_start_count: verifiedStartCount, provider_remains: verifiedRemains,
            provider_charge: verifiedCharge,
            ...(providerIsTerminal
              ? {
                  status: 'completed',
                  completed_at: new Date().toISOString(),
                  ...(providerDeliveredAll && !isTerminalProviderStatus(verifiedStatus)
                    ? { error_message: 'Auto-completed (provider remains reached 0)' }
                    : {}),
                }
              : {}),
            last_status_check: verifiedLastStatusCheck || new Date().toISOString(),
          }).eq('id', run.id).eq('status', 'started'),
          supabase.from('engagement_order_items').update({ status: 'processing' })
            .eq('id', item.id).not('status', 'in', '("cancelled","paused")'),
          supabase.from('engagement_orders').update({ status: 'processing' })
            .eq('id', item.engagement_order_id).not('status', 'in', '("cancelled","paused")'),
        ]
        
        // Snapshot order status BEFORE we flip it, so we can notify only on the first pending→processing transition
        let _prevOrderStatus: string | null = null
        try {
          const { data: eoPrev } = await supabase.from('engagement_orders').select('status').eq('id', item.engagement_order_id).maybeSingle()
          _prevOrderStatus = eoPrev?.status ?? null
        } catch (_) {}

        const [runUpdateResult] = await Promise.all(updatePromises)
        
        if (!runUpdateResult.data || runUpdateResult.data.length === 0) {
          skipped++
          continue
        }

        if (_prevOrderStatus === 'pending') {
          await notifyEngagementOrderStatus(supabase, item.engagement_order_id, 'pending', 'processing')
        }

        if (!executionProviderMap.has(localExecutionKey)) {
          executionProviderMap.set(localExecutionKey, new Set())
        }
        executionProviderMap.get(localExecutionKey)!.add(successAccount.id)

        processed++
        results.push({ 
          run_id: run.id, type: item.engagement_type, run_number: run.run_number,
          success: true, provider_order_id: providerOrderId,
          account_used: successAccount.name, accounts_tried: accountsToTry.length,
          status: providerIsTerminal ? 'completed' : 'started',
        })

        if (providerIsTerminal) {
          await updateEngagementOrderStatus(supabase, item.engagement_order_id, item.id)
        }
      } else if (lastError !== null) {
        const retryCount = (run.retry_count || 0) + 1
        const lastErr = (lastError || '').toLowerCase()
        const isActiveOrderError = lastErr.includes('active order') || lastErr.includes('wait until order') || 
          lastErr.includes('already has an order') || lastErr.includes('in progress')
        
        const postponeMs = isActiveOrderError ? ACTIVE_ORDER_RETRY_MS : TEMPORARY_RETRY_MS
        const newScheduledAt = new Date(Date.now() + postponeMs).toISOString()
        
        await supabase.from('organic_run_schedule').update({
          status: 'pending', started_at: null,
          scheduled_at: newScheduledAt,
          error_message: `[Auto-retry #${retryCount}] All ${accountsToTry.length} accounts busy: ${lastError}`,
          provider_response: {
            ...(providerResult || {}),
            tried_providers: triedProviderIds,
          },
          provider_account_id: null,
          provider_account_name: null,
          provider_order_id: null,
          provider_status: null,
          retry_count: retryCount, last_status_check: new Date().toISOString(),
        }).eq('id', run.id)
        skipped++

        // Stop duplicate attempts for this link+type during this invocation only.
        // Do not rewrite every matching DB row: those rows may have another free
        // mapped provider and link-wide batch postponement caused queue starvation.
        if (isActiveOrderError && sameLink) {
          const linkTypeKey = `${sameLink}|${currentTypeNormalized}`
          activeOrderLinkTypes.add(linkTypeKey)
          console.log(`⏳ Link+type paused for this executor pass; current run will retry in ${postponeMs / 60000}min`)
        }
        results.push({ run_id: run.id, type: item.engagement_type, run_number: run.run_number, 
          success: false, error: lastError, will_retry: true, retry_attempt: retryCount, postponed_min: postponeMs / 60000 })
      }

      // Minimal delay between runs for max throughput
      await new Promise(resolve => setTimeout(resolve, 50))
    }

    // ==========================================
    // STEP 2: Process LEGACY ORDER runs
    // ==========================================
    console.log(`\n--- Processing Legacy Order Runs ---`)
    
    const { data: legacyRuns } = await supabase
      .from('organic_run_schedule')
      .select(`*, order:orders(*, service:services(*))`)
      .eq('status', 'pending')
      .lte('scheduled_at', nowWithBuffer)
      .not('order_id', 'is', null)
      .is('engagement_order_item_id', null)
      .order('scheduled_at', { ascending: true })
      .limit(10)

    console.log(`Found ${legacyRuns?.length || 0} pending legacy runs`)

    for (const run of legacyRuns || []) {
      if (Date.now() - startTime > 55000) {
        shouldContinue = true
        continuationReason = continuationReason || 'legacy-time-slice-exhausted'
        console.log(`⏰ Approaching timeout, stopping legacy processing.`)
        break
      }

      const order = run.order
      if (!order || !order.service) continue

      if (order.status === 'cancelled') {
        await supabase.from('organic_run_schedule').update({
          status: 'cancelled', error_message: 'Order cancelled by user',
          completed_at: new Date().toISOString(),
        }).eq('id', run.id)
        skipped++
        continue
      }
      
      if (order.status === 'paused') { skipped++; continue }

      const startedRunsForOrder = (activeRuns || []).filter((r: any) => r.order_id === order.id)

      if (startedRunsForOrder && startedRunsForOrder.length > 0) {
        const stuckRun = startedRunsForOrder[0]
        const terminalStatuses = ['Completed', 'Partial', 'Refunded', 'Canceled', 'Cancelled', 'Error', 'Failed']
        const isTerminal = stuckRun.provider_status && terminalStatuses.includes(stuckRun.provider_status)
        const startedAt = new Date(stuckRun.started_at || 0)
        const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000)
        const isStuckWithoutStatus = startedAt < twoMinutesAgo && !stuckRun.provider_status
        const isInProgressTooLong = startedAt < twoMinutesAgo && stuckRun.provider_status === 'In progress'
        const isPendingTooLong = startedAt < twoMinutesAgo && stuckRun.provider_status === 'Pending'
        
        if (isTerminal || isStuckWithoutStatus || isInProgressTooLong || isPendingTooLong) {
          // SCAM GUARD: detect 0-delivered fake completions and retry instead
          const qty = stuckRun.quantity_to_send || 0
          const remains = typeof stuckRun.provider_remains === 'number' ? stuckRun.provider_remains : null
          const startCount = typeof stuckRun.provider_start_count === 'number' ? stuckRun.provider_start_count : null
          const deliveredZero = remains !== null && qty > 0 && remains >= qty && (startCount === null || startCount === 0)
          const retryCount = stuckRun.retry_count || 0
          if (deliveredZero && !isTerminal && retryCount < 15) {
            await supabase.from('organic_run_schedule').update({
              status: 'failed', completed_at: new Date().toISOString(),
              error_message: `Auto-retry: provider ${stuckRun.provider_status || 'unknown'} with 0 delivered (remains=${remains}/${qty})`,
            }).eq('id', stuckRun.id)
          } else {
            await supabase.from('organic_run_schedule').update({
              status: 'completed', completed_at: new Date().toISOString(),
              error_message: `Auto-completed (status: ${stuckRun.provider_status || 'unknown'})`,
            }).eq('id', stuckRun.id)
          }
        } else {
          if (hasUncertainDispatch(stuckRun)) {
            skipped++
            continue
          }

          const runAge = Math.round((Date.now() - startedAt.getTime()) / 1000)
          if (runAge < 60) { skipped++; continue }
        }
      }

      const { data: provider } = await supabase
        .from('providers').select('*')
        .eq('id', order.service.provider_id).maybeSingle()

      if (!provider) {
        await supabase.from('organic_run_schedule').update({
          status: 'failed', error_message: 'Provider not found',
        }).eq('id', run.id)
        failed++
        continue
      }

      if (!isValidHttpUrl(provider.api_url)) {
        await supabase.from('organic_run_schedule').update({
          status: 'failed', error_message: 'Provider has invalid API URL',
        }).eq('id', run.id)
        failed++
        continue
      }

      const { error: updateError, locked: lockAcquired } = await claimRunLock({
        supabase,
        runId: run.id,
        expectedStatus: 'pending',
        updates: { status: 'started', started_at: new Date().toISOString() },
      })

      if (updateError) continue
      if (!lockAcquired) {
        skipped++
        continue
      }

      let lastError: string | null = null
      let providerOrderId: string | null = null

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          const formData = new URLSearchParams()
          formData.append('key', provider.api_key)
          formData.append('action', 'add')
          formData.append('service', order.service.provider_service_id)
          formData.append('link', order.link)
          formData.append('quantity', run.quantity_to_send.toString())

          const controller = new AbortController()
          const timeoutId = setTimeout(() => controller.abort(), 30000)
          const response = await fetch(provider.api_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: formData.toString(), signal: controller.signal,
          })
          clearTimeout(timeoutId)
          const result = await response.json().catch(() => ({ error: 'Invalid response' }))

          if (result.status === 'fail' || result.error) {
            lastError = result.message || result.error
            if (typeof lastError !== 'string') lastError = JSON.stringify(lastError)
            const isTemporaryError = TEMPORARY_ERRORS.some(err => lastError!.toLowerCase().includes(err.toLowerCase()))
            if (isTemporaryError) { lastError = `TEMP_ERROR: ${lastError}`; break }
            if (attempt < MAX_RETRIES) {
              await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS * attempt))
              retried++; continue
            }
          } else {
            providerOrderId = result.order?.toString() || result.id?.toString()
            break
          }
        } catch (fetchError: any) {
          const uncertainDispatchAt = new Date().toISOString()
          await supabase.from('organic_run_schedule').update({
            status: 'started',
            started_at: run.started_at || uncertainDispatchAt,
            completed_at: null,
            error_message: `Network error after provider request. [Dispatch uncertain] Verify provider before retrying: ${fetchError.message || 'Unknown'}`,
            provider_response: {
              uncertain_dispatch: true,
              stage: 'provider_add_request',
              fetch_error: fetchError.message || 'Unknown',
              happened_at: uncertainDispatchAt,
            },
          }).eq('id', run.id).eq('status', 'started')

          lastError = null
          skipped++
          break
        }
      }

      if (providerOrderId) {
        await supabase.from('organic_run_schedule').update({ provider_order_id: providerOrderId }).eq('id', run.id)
        await supabase.from('orders').update({ status: 'processing' }).eq('id', order.id)
        processed++
      } else {
        const isTemporaryError = lastError?.startsWith('TEMP_ERROR:')
        if (isTemporaryError) {
          const cleanError = lastError?.replace('TEMP_ERROR: ', '') || ''
          const isActiveOrder = cleanError.toLowerCase().includes('active order') || cleanError.toLowerCase().includes('wait until order')
          const postponeMs = isActiveOrder ? ACTIVE_ORDER_RETRY_MS : TEMPORARY_RETRY_MS
          await supabase.from('organic_run_schedule').update({
            status: 'pending', started_at: null,
            scheduled_at: new Date(Date.now() + postponeMs).toISOString(),
            error_message: `[Will retry] ${cleanError}`,
          }).eq('id', run.id)
          skipped++
        } else {
          await supabase.from('organic_run_schedule').update({
            status: 'failed', error_message: lastError || 'Failed after retries',
          }).eq('id', run.id)
          failed++
        }
      }
    }

    const totalTime = Date.now() - startTime

    // Do not recursively invoke another synchronous worker here. A large
    // imported backlog can otherwise create a chain of 50-second requests
    // until the edge-runtime kills them with WorkerRequestCancelled. The
    // every-minute cron safely picks up the next fair batch instead.
    if (shouldContinue) {
      console.log(`⏭️ More runs remain (${continuationReason || 'time-slice-exhausted'}); next cron cycle will continue`)
    }

    console.log(`\n=== EXECUTION COMPLETE [${executionId}] in ${totalTime}ms ===`)
    console.log(`Processed: ${processed}, Skipped: ${skipped}, Failed: ${failed}, Retried: ${retried}`)

    // Send admin alert if failures
    if (failed > 0) {
      try {
        await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/send-admin-alert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${Deno.env.get('SUPABASE_ANON_KEY')}` },
          body: JSON.stringify({
            job_name: 'execute-all-runs', execution_id: executionId,
            failed_count: failed, processed_count: processed, skipped_count: skipped,
            error_details: results.filter(r => !r.success).slice(0, 10).map(r => ({
              run_id: r.run_id, run_number: r.run_number, type: r.type, error: r.error
            }))
          })
        })
      } catch (alertError) {
        console.error('Failed to send admin alert:', alertError)
      }
    }

    console.log(`✅ Background execution [${executionId}] complete: ${processed} processed, ${skipped} skipped, ${failed} failed`)

    return { processed, skipped, failed, retried, should_continue: shouldContinue }

  } catch (error: any) {
    console.error(`❌ Background execution error:`, error)
    throw error
  }
}
