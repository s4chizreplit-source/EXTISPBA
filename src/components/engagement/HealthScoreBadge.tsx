import { useMemo } from "react";
import { Activity, ShieldCheck, AlertTriangle } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface RunLike {
  provider_start_count?: number | null;
  provider_remains?: number | null;
  quantity_to_send?: number | null;
  status?: string | null;
  scheduled_at?: string | null;
  completed_at?: string | null;
}

export interface HealthBreakdown {
  retention: number;   // 0-100
  velocity: number;    // 0-100
  spread: number;      // 0-100
  total: number;       // 0-100
  totalSent: number;
  totalDelivered: number;
  runsDone: number;
  runsTotal: number;
}

export function computeHealth(runs: RunLike[]): HealthBreakdown {
  const completed = runs.filter((r) => r.status === "completed");
  let totalSent = 0;
  let totalDelivered = 0;
  for (const r of completed) {
    const sent = Number(r.quantity_to_send || 0);
    const remains = Number(r.provider_remains ?? 0);
    totalSent += sent;
    totalDelivered += Math.max(0, sent - remains);
  }
  const retention = totalSent > 0 ? (totalDelivered / totalSent) * 100 : 100;

  const runsTotal = runs.length;
  const runsDone = completed.length;
  const velocity = runsTotal > 0 ? (runsDone / runsTotal) * 100 : 0;

  // Spread: gap CV (lower = more organic). Use coefficient of variation of gaps.
  const times = completed
    .map((r) => (r.completed_at ? new Date(r.completed_at).getTime() : 0))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
  let spread = 100;
  if (times.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 0;
    // CV ~0.4-0.7 is organic. Penalize too uniform (cv<0.1) or too erratic (cv>1.5)
    if (cv < 0.1) spread = 60;
    else if (cv > 1.5) spread = 50;
    else spread = 100 - Math.abs(cv - 0.5) * 60;
  }

  const total = Math.round(retention * 0.6 + velocity * 0.25 + spread * 0.15);
  return {
    retention: Math.round(retention),
    velocity: Math.round(velocity),
    spread: Math.round(spread),
    total: Math.min(100, Math.max(0, total)),
    totalSent,
    totalDelivered,
    runsDone,
    runsTotal,
  };
}

function tierFor(score: number) {
  if (score >= 85) return { label: "Excellent", color: "#1d4ed8", bg: "#f5f9ff", border: "#dbeafe", icon: ShieldCheck };
  if (score >= 70) return { label: "Good", color: "#0ea5e9", bg: "#f0f9ff", border: "#e0f2fe", icon: Activity };
  if (score >= 50) return { label: "Fair", color: "#f59e0b", bg: "#fffbeb", border: "#fef3c7", icon: Activity };
  return { label: "Poor", color: "#ef4444", bg: "#fef2f2", border: "#fecaca", icon: AlertTriangle };
}

interface Props {
  runs: RunLike[];
  compact?: boolean;
}

export function HealthScoreBadge({ runs, compact = false }: Props) {
  const h = useMemo(() => computeHealth(runs), [runs]);
  if (h.runsDone === 0) return null;
  const t = tierFor(h.total);
  const Icon = t.icon;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold transition-all hover:scale-105"
          style={{ background: t.bg, border: `1px solid ${t.border}`, color: t.color }}
          title="Click for health breakdown"
        >
          <Icon className="w-3 h-3" />
          {compact ? h.total : `Health ${h.total}/100`}
          {!compact && <span className="opacity-70">• {t.label}</span>}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-4">
        <div className="flex items-center gap-2 mb-3">
          <Icon className="w-4 h-4" style={{ color: t.color }} />
          <div>
            <p className="text-sm font-bold" style={{ color: t.color }}>{t.label} — {h.total}/100</p>
            <p className="text-[10px] text-muted-foreground">Organic quality score</p>
          </div>
        </div>
        <div className="space-y-2">
          <Row label="Retention" value={h.retention} hint={`${h.totalDelivered}/${h.totalSent} delivered`} />
          <Row label="Velocity" value={h.velocity} hint={`${h.runsDone}/${h.runsTotal} runs done`} />
          <Row label="Organic spread" value={h.spread} hint="Run timing pattern" />
        </div>
        <p className="text-[10px] text-muted-foreground mt-3 leading-relaxed">
          Higher = more human-like delivery. Drop, run completion, and pacing variance feed this score.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function Row({ label, value, hint }: { label: string; value: number; hint: string }) {
  const c = value >= 75 ? "#1d4ed8" : value >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div>
      <div className="flex justify-between text-[11px] mb-1">
        <span className="font-medium">{label}</span>
        <span className="font-bold" style={{ color: c }}>{value}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
        <div className="h-full transition-all" style={{ width: `${value}%`, background: c }} />
      </div>
      <p className="text-[9px] text-muted-foreground mt-0.5">{hint}</p>
    </div>
  );
}
