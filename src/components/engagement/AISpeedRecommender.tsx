import { useState } from "react";
import { Brain, Loader2, Sparkles, AlertTriangle, ShieldCheck } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Recommendation {
  delivery_hours?: number;
  runs?: number;
  per_type_hours?: Record<string, number>;
  safety_score?: number;
  warnings?: string[];
  explanation?: string;
}

interface Props {
  link: string;
  platform: string;
  types: string[];
  totalQuantity: number;
  onApply?: (rec: Recommendation) => void;
}

export function AISpeedRecommender({ link, platform, types, totalQuantity, onApply }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rec, setRec] = useState<Recommendation | null>(null);

  const askAI = async () => {
    if (!link || types.length === 0 || totalQuantity <= 0) {
      toast({ title: "Add link, types & quantity first", variant: "destructive" });
      return;
    }
    setLoading(true);
    setRec(null);
    const { data, error } = await supabase.functions.invoke("ai-speed-recommender", {
      body: { link, platform, types, totalQuantity },
    });
    setLoading(false);
    if (error) {
      toast({ title: "AI error", description: error.message, variant: "destructive" });
      return;
    }
    if (data?.error) {
      toast({ title: "AI error", description: data.error, variant: "destructive" });
      return;
    }
    setRec(data?.recommendation || {});
  };

  const safety = rec?.safety_score || 0;
  const safetyColor = safety >= 80 ? "#1d4ed8" : safety >= 60 ? "#f59e0b" : "#ef4444";

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (o) askAI(); }}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
        >
          <Brain className="w-3.5 h-3.5" />
          Ask AI for best speed
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-700" />
            AI Speed Recommender
          </DialogTitle>
          <DialogDescription className="text-xs">
            Safest organic delivery plan for your post.
          </DialogDescription>
        </DialogHeader>

        {loading && (
          <div className="flex items-center justify-center py-8 gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin text-amber-700" />
            Analyzing your post…
          </div>
        )}

        {!loading && rec && (
          <div className="space-y-3">
            <div className="rounded-xl border p-3" style={{ background: `${safetyColor}10`, borderColor: `${safetyColor}40` }}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: safetyColor }}>
                  Safety Score
                </span>
                <span className="text-2xl font-extrabold" style={{ color: safetyColor }}>{safety}/100</span>
              </div>
              {rec.explanation && (
                <p className="text-[11px] leading-relaxed text-foreground/80 mt-2">{rec.explanation}</p>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <Stat label="Total time" value={rec.delivery_hours ? `${rec.delivery_hours}h` : "—"} />
              <Stat label="Runs" value={rec.runs ? String(rec.runs) : "—"} />
            </div>

            {rec.per_type_hours && Object.keys(rec.per_type_hours).length > 0 && (
              <div className="rounded-lg border bg-muted/30 p-2">
                <p className="text-[10px] font-semibold uppercase text-muted-foreground mb-1">Per type</p>
                {Object.entries(rec.per_type_hours).map(([k, v]) => (
                  <div key={k} className="flex justify-between text-[11px] py-0.5">
                    <span className="capitalize">{k}</span>
                    <span className="font-semibold">{v}h</span>
                  </div>
                ))}
              </div>
            )}

            {rec.warnings && rec.warnings.length > 0 && (
              <div className="rounded-lg bg-amber-50 border border-amber-200 p-2">
                {rec.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-900">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" /> {w}
                  </p>
                ))}
              </div>
            )}

            {onApply && (
              <Button
                onClick={() => { onApply(rec); setOpen(false); toast({ title: "Recommendation applied" }); }}
                className="w-full bg-amber-700 hover:bg-amber-800"
                size="sm"
              >
                <ShieldCheck className="w-3.5 h-3.5 mr-1.5" /> Apply this plan
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-2 text-center">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="text-sm font-bold">{value}</p>
    </div>
  );
}
