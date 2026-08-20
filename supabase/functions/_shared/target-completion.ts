/**
 * Target-based auto-completion.
 *
 * When the ordered TARGET for an engagement item is reached we cancel the
 * remaining pending runs with an INTERNAL reason (never shown to users) and
 * mark the item / order as COMPLETED.
 *
 * All computations are idempotent: running this repeatedly on the same data
 * produces the same result and never lowers `delivered`.
 */

const PROCESSING_PROVIDER_STATUSES = ['pending', 'in progress', 'inprogress', 'processing', 'awaiting']
const norm = (v: unknown) => (v ?? '').toString().toLowerCase().trim()

export interface RunRow {
  id?: string
  status?: string | null
  provider_status?: string | null
  quantity_to_send?: number | null
  provider_remains?: number | null
  provider_start_count?: number | null
  provider_charge?: number | null
  error_message?: string | null
}

export interface DeliverySummary {
  target: number
  startCount: number | null
  currentCount: number | null
  delivered: number
  remaining: number
  progress: number
  targetMet: boolean
  askedSent: number
  observedByRuns: number
  publicDelta: number | null
}

/** Section 2 of the spec: never trust public count alone. */
export function computeDelivery(runs: RunRow[], target: number): DeliverySummary {
  const list = (runs || []).filter(Boolean)
  const qty = (r: RunRow) => Number(r.quantity_to_send || 0)

  let askedSent = 0
  let observedByRuns = 0
  const startCounts: number[] = []
  const currentCounts: number[] = []

  for (const r of list) {
    const status = norm(r.status)
    const providerStatus = norm(r.provider_status)
    const sent = status === 'completed' || status === 'started' || status === 'partial' ||
      PROCESSING_PROVIDER_STATUSES.includes(providerStatus)

    if (sent) askedSent += qty(r)

    const remains = Number(r.provider_remains)
    if (sent && r.provider_remains !== null && r.provider_remains !== undefined && Number.isFinite(remains)) {
      observedByRuns += Math.max(0, qty(r) - remains)
    }

    const sc = Number(r.provider_start_count)
    if (Number.isFinite(sc) && sc > 0) {
      startCounts.push(sc)
      const delta = Number.isFinite(remains) ? Math.max(0, qty(r) - remains) : 0
      currentCounts.push(sc + delta)
    }
  }

  const startCount = startCounts.length ? Math.min(...startCounts) : null
  const currentCount = currentCounts.length ? Math.max(...currentCounts) : null
  const publicDelta = startCount !== null && currentCount !== null
    ? Math.max(0, currentCount - startCount) : null

  const trustedDelivered = Math.max(askedSent, observedByRuns)
  // Organic-growth guard: public delta only counts on genuine over-delivery
  const publicOverdelivery = (askedSent > 0 && publicDelta !== null &&
    publicDelta > Math.max(askedSent * 2, target + 500)) ? publicDelta : 0

  const delivered = Math.max(trustedDelivered, publicOverdelivery)
  const remaining = Math.max(0, target - delivered)

  return {
    target,
    startCount,
    currentCount,
    delivered,
    remaining,
    progress: target > 0 ? Math.min(100, (delivered / target) * 100) : 0,
    targetMet: target > 0 && delivered >= target,
    askedSent,
    observedByRuns,
    publicDelta,
  }
}

/**
 * Fake-completion guard (Section 6): provider says completed but nothing was
 * actually delivered and no charge was taken.
 */
export function isFakeProviderCompletion(run: RunRow): boolean {
  const qty = Number(run.quantity_to_send || 0)
  const remains = Number(run.provider_remains)
  const startCount = Number(run.provider_start_count)
  const charge = Number(run.provider_charge)
  const noStart = !Number.isFinite(startCount) || startCount <= 0
  const noCharge = !Number.isFinite(charge) || charge <= 0
  return qty > 0 && Number.isFinite(remains) && remains >= qty && noStart && noCharge
}

const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'canceled']

/**
 * Sections 3 + 5: recompute counters for every item of an engagement order and
 * auto-close the ones whose target has been met.
 */
export async function enforceTargetCompletion(
  supabase: any,
  engagementOrderId: string | null | undefined,
): Promise<void> {
  if (!engagementOrderId) return

  const { data: order } = await supabase
    .from('engagement_orders')
    .select('id, status, base_quantity')
    .eq('id', engagementOrderId)
    .maybeSingle()

  if (!order || order.status === 'cancelled') return

  const { data: items } = await supabase
    .from('engagement_order_items')
    .select('id, quantity, status, engagement_type')
    .eq('engagement_order_id', engagementOrderId)

  if (!items || items.length === 0) return

  let allTargetsMet = true

  for (const item of items) {
    if (item.status === 'cancelled') { allTargetsMet = false; continue }

    const target = Number(item.quantity || 0)
    const { data: runs } = await supabase
      .from('organic_run_schedule')
      .select('id, status, provider_status, quantity_to_send, provider_remains, provider_start_count, provider_charge, error_message')
      .eq('engagement_order_item_id', item.id)

    const summary = computeDelivery(runs || [], target)

    if (!summary.targetMet) {
      allTargetsMet = false
      continue
    }

    const marker = `Target met (asked=${summary.askedSent}, observed=${summary.observedByRuns}, ` +
      `public_delta=${summary.publicDelta ?? 'n/a'}, target=${target}) — remaining runs cancelled internally`

    // (a) cancel remaining pending / scheduled runs with an INTERNAL reason
    const leftover = (runs || []).filter((r: RunRow) =>
      !TERMINAL_RUN_STATUSES.includes(norm(r.status)))
    if (leftover.length > 0) {
      await supabase
        .from('organic_run_schedule')
        .update({
          status: 'cancelled',
          error_message: marker,
          completed_at: new Date().toISOString(),
        })
        .in('id', leftover.map((r: RunRow) => r.id))
    }

    // (b) item completed (idempotent)
    if (item.status !== 'completed') {
      await supabase
        .from('engagement_order_items')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('id', item.id)
        .neq('status', 'cancelled')
    }

    console.log(`✅ Item ${item.id} (${item.engagement_type}) — ${marker}`)
  }

  if (allTargetsMet && order.status !== 'completed') {
    await supabase
      .from('engagement_orders')
      .update({ status: 'completed', completed_at: new Date().toISOString() })
      .eq('id', engagementOrderId)
      .neq('status', 'cancelled')
    console.log(`✅ Engagement order ${engagementOrderId} auto-completed (all targets met)`)
  }
}
