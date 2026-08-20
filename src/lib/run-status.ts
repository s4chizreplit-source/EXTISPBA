/**
 * Target-based delivery helpers.
 *
 * Backend markers: runs that were cancelled for INTERNAL reasons (target already
 * met, merged into another run, etc.) must never be shown to the user as
 * "Cancelled" and their reason must never be surfaced.
 */

export interface RunLike {
  status?: string | null;
  error_message?: string | null;
  quantity_to_send?: number | null;
  provider_remains?: number | null;
  provider_start_count?: number | null;
  provider_status?: string | null;
}

const TARGET_MET_PREFIX = 'target met';

/** Internal cancellation reasons that must stay hidden from users. */
const INTERNAL_CANCEL_PREFIXES = [
  'target met',
  'target count reached',
  'merged into run',
];

const norm = (v: unknown) => (v ?? '').toString().toLowerCase().trim();

function isCancelled(run: RunLike | null | undefined): boolean {
  const s = norm(run?.status);
  return s === 'cancelled' || s === 'canceled';
}

export function isTargetMetAutoCompleted(run: RunLike | null | undefined): boolean {
  if (!run) return false;
  return isCancelled(run) && norm(run.error_message).startsWith(TARGET_MET_PREFIX);
}

/** True when the run was cancelled by the system for internal bookkeeping. */
export function isInternalCancelledRun(run: RunLike | null | undefined): boolean {
  if (!run || !isCancelled(run)) return false;
  const msg = norm(run.error_message);
  return INTERNAL_CANCEL_PREFIXES.some((p) => msg.startsWith(p));
}

/**
 * Runs that should not appear anywhere in the user-facing timeline/history.
 * Target-met runs stay visible but render as "Completed"; purely internal
 * bookkeeping rows (merged runs, duplicate target rows) are hidden.
 */
export function shouldHideRunFromUser(run: RunLike | null | undefined): boolean {
  return isInternalCancelledRun(run) && !isTargetMetAutoCompleted(run);
}

/** Reason safe to show the user (null for internal cancellations). */
export function getUserFacingRunReason(run: RunLike | null | undefined): string | null {
  if (!run || isInternalCancelledRun(run)) return null;
  return run.error_message || null;
}

/** Returns the status to display in the UI (Completed instead of Cancelled when target was met). */
export function getUserFacingRunStatus(run: RunLike | null | undefined): string {
  if (isTargetMetAutoCompleted(run)) return 'completed';
  return norm(run?.status);
}

/** True if this run should be counted as delivered (real complete OR auto-completed). */
export function countsAsDelivered(run: RunLike | null | undefined): boolean {
  const raw = norm(run?.status);
  return raw === 'completed' || isTargetMetAutoCompleted(run);
}

const PROCESSING_PROVIDER_STATUSES = ['pending', 'in progress', 'inprogress', 'processing', 'awaiting'];

export interface DeliverySummary {
  target: number;
  startCount: number | null;
  currentCount: number | null;
  delivered: number;
  remaining: number;
  progress: number;
  targetMet: boolean;
  askedSent: number;
  observedByRuns: number;
  publicDelta: number | null;
}

/**
 * Computes delivery counters for a set of runs belonging to one target
 * (item or whole order). Never trusts the public count alone — see the
 * 2x + 500 over-delivery threshold.
 */
export function computeDelivery(runs: RunLike[] | null | undefined, target: number): DeliverySummary {
  const list = (runs || []).filter(Boolean);
  const qty = (r: RunLike) => Number(r.quantity_to_send || 0);

  let askedSent = 0;
  let observedByRuns = 0;
  const startCounts: number[] = [];
  const currentCounts: number[] = [];

  for (const r of list) {
    const status = norm(r.status);
    const providerStatus = norm(r.provider_status);
    const sent =
      status === 'completed' ||
      status === 'started' ||
      status === 'partial' ||
      PROCESSING_PROVIDER_STATUSES.includes(providerStatus);

    if (sent) askedSent += qty(r);

    const remains = r.provider_remains;
    if (sent && remains !== null && remains !== undefined && Number.isFinite(Number(remains))) {
      observedByRuns += Math.max(0, qty(r) - Number(remains));
    }

    const sc = Number(r.provider_start_count);
    if (Number.isFinite(sc) && sc > 0) {
      startCounts.push(sc);
      const remainsNum = Number(remains);
      const delta = Number.isFinite(remainsNum) ? Math.max(0, qty(r) - remainsNum) : 0;
      currentCounts.push(sc + delta);
    }
  }

  const startCount = startCounts.length ? Math.min(...startCounts) : null;
  const currentCount = currentCounts.length ? Math.max(...currentCounts) : null;
  const publicDelta =
    startCount !== null && currentCount !== null ? Math.max(0, currentCount - startCount) : null;

  const trustedDelivered = Math.max(askedSent, observedByRuns);
  const publicOverdelivery =
    askedSent > 0 && publicDelta !== null && publicDelta > Math.max(askedSent * 2, target + 500)
      ? publicDelta
      : 0;

  const delivered = Math.max(trustedDelivered, publicOverdelivery);
  const remaining = Math.max(0, target - delivered);
  const progress = target > 0 ? Math.min(100, (delivered / target) * 100) : 0;

  return {
    target,
    startCount,
    currentCount,
    delivered,
    remaining,
    progress,
    targetMet: target > 0 && delivered >= target,
    askedSent,
    observedByRuns,
    publicDelta,
  };
}
