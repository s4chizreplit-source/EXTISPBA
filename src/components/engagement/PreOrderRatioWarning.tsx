import { useMemo } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ShieldCheck, AlertTriangle } from "lucide-react";
import { analyzeCounts, type Counts } from "@/lib/engagement-ratio";
import { cn } from "@/lib/utils";

interface EngagementLike {
  type: string;
  enabled?: boolean;
  quantity: number;
}

interface Props {
  engagements: Record<string, EngagementLike>;
}

/** Map the project's engagement type keys → our ratio counter keys. */
function buildCounts(engagements: Record<string, EngagementLike>): Counts {
  const c: Counts = { views: 0, likes: 0, comments: 0, shares: 0, saves: 0 };
  for (const [type, cfg] of Object.entries(engagements)) {
    if (cfg.enabled === false) continue;
    const q = cfg.quantity || 0;
    if (q <= 0) continue;
    const t = type.toLowerCase();
    if (t.includes("view") || t.includes("impression") || t.includes("reach") || t.includes("plays")) c.views! += q;
    else if (t.includes("like") || t.includes("reaction")) c.likes! += q;
    else if (t.includes("comment")) c.comments! += q;
    else if (t.includes("share") || t.includes("repost")) c.shares! += q;
    else if (t.includes("save") || t.includes("bookmark")) c.saves! += q;
  }
  return c;
}

export function PreOrderRatioWarning({ engagements }: Props) {
  const report = useMemo(() => analyzeCounts(buildCounts(engagements)), [engagements]);

  // Hide if there's nothing meaningful to analyze yet
  if (!report.views || report.checks.length === 0) return null;

  const tone =
    report.healthScore >= 80
      ? { Icon: ShieldCheck, color: "text-emerald-600", border: "border-emerald-500/40", bg: "bg-emerald-500/10", title: "Healthy organic mix" }
      : report.healthScore >= 50
      ? { Icon: ShieldAlert, color: "text-amber-600", border: "border-amber-500/40", bg: "bg-amber-500/10", title: "Ratios look off — order will still place" }
      : { Icon: AlertTriangle, color: "text-red-600", border: "border-red-500/40", bg: "bg-red-500/10", title: "High bot-pattern risk — adjust before placing" };

  return (
    <Alert className={cn("border-2", tone.border, tone.bg)}>
      <tone.Icon className={cn("h-5 w-5", tone.color)} />
      <AlertTitle className={cn("font-bold flex items-center gap-2 flex-wrap", tone.color)}>
        {tone.title}
        <Badge variant="outline" className={cn("border-current font-bold", tone.color)}>
          Botting {report.bottingPct}% · Health {report.healthScore}/100
        </Badge>
      </AlertTitle>
      <AlertDescription className="space-y-2">
        <div className="flex flex-wrap gap-1.5 mt-1">
          {report.checks.map((c) => {
            const ok = c.status === "ok";
            const danger = c.status === "danger_low" || c.status === "danger_high";
            return (
              <Badge
                key={c.key}
                variant="outline"
                className={cn(
                  "font-medium",
                  ok && "text-emerald-700 border-emerald-500/40 bg-emerald-500/10",
                  !ok && !danger && "text-amber-700 border-amber-500/40 bg-amber-500/10",
                  danger && "text-red-700 border-red-500/50 bg-red-500/10"
                )}
                title={c.message}
              >
                {c.label}: {c.ratioPct.toFixed(2)}%
              </Badge>
            );
          })}
        </div>
        {report.suggestions.length > 0 && (
          <ul className="text-xs list-disc pl-5 space-y-0.5 text-foreground/80">
            {report.suggestions.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        )}
        <p className="text-[11px] text-muted-foreground">
          Tip: Instagram's organic norms are ~4–10% likes, ~0.3–1.5% comments per view. Stay close to these for the most natural-looking growth.
        </p>
      </AlertDescription>
    </Alert>
  );
}
