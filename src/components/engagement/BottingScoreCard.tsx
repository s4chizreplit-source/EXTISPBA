import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { ShieldCheck, ShieldAlert, AlertTriangle, Sparkles } from "lucide-react";
import { analyzeCounts, type Counts, type RatioCheck } from "@/lib/engagement-ratio";
import { cn } from "@/lib/utils";

interface Props {
  /** Live per-type delivered counts */
  delivered: Counts;
  /** Optional planned targets, for context */
  targets?: Counts;
  /** "live" (post-order) or "preview" */
  mode?: "live" | "preview";
}

const STATUS_COLOR: Record<RatioCheck["status"], string> = {
  ok: "text-emerald-600 bg-emerald-500/10 border-emerald-500/30",
  low: "text-amber-600 bg-amber-500/10 border-amber-500/30",
  high: "text-amber-600 bg-amber-500/10 border-amber-500/30",
  danger_low: "text-red-600 bg-red-500/10 border-red-500/40",
  danger_high: "text-red-600 bg-red-500/10 border-red-500/40",
  none: "text-muted-foreground bg-muted/40 border-border",
};

const STATUS_LABEL: Record<RatioCheck["status"], string> = {
  ok: "Healthy",
  low: "Low",
  high: "High",
  danger_low: "Bot risk",
  danger_high: "Suspicious",
  none: "—",
};

export function BottingScoreCard({ delivered, targets, mode = "live" }: Props) {
  const live = analyzeCounts(delivered);
  const planned = targets ? analyzeCounts(targets) : null;

  const health = live.healthScore;
  const botting = live.bottingPct;

  const tone =
    health >= 80
      ? { color: "text-emerald-600", bg: "from-emerald-500/10 to-emerald-500/5", border: "border-emerald-500/30", Icon: ShieldCheck, label: "Organic-looking" }
      : health >= 50
      ? { color: "text-amber-600", bg: "from-amber-500/10 to-amber-500/5", border: "border-amber-500/30", Icon: ShieldAlert, label: "Watch ratios" }
      : { color: "text-red-600", bg: "from-red-500/10 to-red-500/5", border: "border-red-500/40", Icon: AlertTriangle, label: "Bot-pattern risk" };

  return (
    <Card className={cn("border-2 bg-gradient-to-br overflow-hidden", tone.bg, tone.border)}>
      <CardContent className="p-4 sm:p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3 min-w-0">
            <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center bg-background/60", tone.color)}>
              <tone.Icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-bold text-base sm:text-lg leading-tight">
                {mode === "live" ? "Live Engagement Health" : "Engagement Ratio Preview"}
              </h3>
              <p className="text-xs text-muted-foreground">
                Botting % is calculated from likes / comments / shares / saves vs views.
              </p>
            </div>
          </div>
          <div className="flex gap-2 flex-wrap">
            <Badge variant="outline" className={cn("font-bold", tone.color, "border-current")}>
              {tone.label}
            </Badge>
          </div>
        </div>

        {/* Two big numbers */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl bg-background/70 p-3 border border-border">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Organic Score</div>
            <div className={cn("text-3xl font-bold tabular-nums", tone.color)}>{health}<span className="text-base text-muted-foreground">/100</span></div>
            <Progress value={health} className="h-1.5 mt-2" />
          </div>
          <div className="rounded-xl bg-background/70 p-3 border border-border">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">Botting %</div>
            <div className={cn("text-3xl font-bold tabular-nums", botting > 50 ? "text-red-600" : botting > 20 ? "text-amber-600" : "text-emerald-600")}>
              {botting}%
            </div>
            <Progress value={botting} className="h-1.5 mt-2" />
          </div>
        </div>

        {/* Per-ratio meters */}
        {live.checks.length > 0 && (
          <div className="space-y-2">
            {live.checks.map((c) => (
              <div key={c.key} className={cn("rounded-lg border px-3 py-2 flex items-center justify-between gap-3", STATUS_COLOR[c.status])}>
                <div className="min-w-0">
                  <div className="text-xs font-bold uppercase tracking-wide truncate">{c.label}</div>
                  <div className="text-[11px] opacity-80 truncate">
                    {c.value.toLocaleString()} / {live.views.toLocaleString()} views = <b>{c.ratioPct.toFixed(2)}%</b>
                    <span className="opacity-70"> · target {c.band.lowOk}–{c.band.highOk}%</span>
                  </div>
                </div>
                <Badge variant="outline" className="border-current font-bold whitespace-nowrap">
                  {STATUS_LABEL[c.status]}
                </Badge>
              </div>
            ))}
          </div>
        )}

        {/* Suggestions */}
        {live.suggestions.length > 0 && (
          <div className="rounded-lg bg-background/70 border border-border p-3 space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-muted-foreground">
              <Sparkles className="h-3.5 w-3.5" /> Suggestions to look more organic
            </div>
            <ul className="text-xs text-foreground space-y-1 list-disc pl-5">
              {live.suggestions.slice(0, 4).map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          </div>
        )}

        {planned && mode === "live" && planned.healthScore !== health && (
          <div className="text-[11px] text-muted-foreground">
            Planned-order score was <b>{planned.healthScore}</b>/100 · current live <b>{health}</b>/100
          </div>
        )}
      </CardContent>
    </Card>
  );
}
