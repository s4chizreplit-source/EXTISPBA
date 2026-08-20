import { useState } from "react";
import { Shield, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface Props {
  itemId?: string;       // engagement_order_items.id
  orderId?: string;      // orders.id
  enabled: boolean;
  threshold: number;
  maxRefills: number;
  count: number;
  onUpdated?: () => void;
}

export function AutoRefillToggle({ itemId, orderId, enabled, threshold, maxRefills, count, onUpdated }: Props) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [localEnabled, setLocalEnabled] = useState(enabled);
  const [localThreshold, setLocalThreshold] = useState(threshold);
  const [localMax, setLocalMax] = useState(maxRefills);

  const id = itemId || orderId;

  type RefillPatch = {
    auto_refill_enabled?: boolean;
    auto_refill_threshold_pct?: number;
    auto_refill_max?: number;
  };
  const save = async (patch: RefillPatch) => {
    if (!id) return;
    setBusy(true);
    const q = itemId
      ? supabase.from("engagement_order_items").update(patch).eq("id", id)
      : supabase.from("orders").update(patch).eq("id", id);
    const { error } = await q;
    setBusy(false);
    if (error) {
      toast({ title: "Save failed", description: error.message, variant: "destructive" });
      return;
    }
    onUpdated?.();
  };

  return (
    <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/10 p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-emerald-400/20 flex items-center justify-center">
            <Shield className="w-4 h-4 text-emerald-300" />
          </div>
          <div>
            <p className="text-[13px] font-bold text-emerald-100">Auto-Refill Insurance</p>
            <p className="text-[10px] text-emerald-200/80">
              {count > 0 ? `Refilled ${count}/${maxRefills} times` : "Auto-tops up if drop exceeds threshold"}
            </p>
          </div>
        </div>
        <Switch
          checked={localEnabled}
          disabled={busy}
          onCheckedChange={(v) => {
            setLocalEnabled(v);
            save({ auto_refill_enabled: v });
          }}
        />
      </div>

      {localEnabled && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div>
            <Label className="text-[10px] text-emerald-200">Drop threshold (%)</Label>
            <Input
              type="number"
              min={1}
              max={50}
              value={localThreshold}
              onChange={(e) => setLocalThreshold(Number(e.target.value))}
              onBlur={() => save({ auto_refill_threshold_pct: localThreshold })}
              className="h-8 text-xs"
            />
          </div>
          <div>
            <Label className="text-[10px] text-emerald-200">Max refills</Label>
            <Input
              type="number"
              min={1}
              max={10}
              value={localMax}
              onChange={(e) => setLocalMax(Number(e.target.value))}
              onBlur={() => save({ auto_refill_max: localMax })}
              className="h-8 text-xs"
            />
          </div>
        </div>
      )}
      {busy && <Loader2 className="w-3 h-3 animate-spin text-emerald-300 mt-2" />}
    </div>
  );
}
