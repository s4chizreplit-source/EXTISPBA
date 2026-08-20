import { useState } from "react";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { Rocket, Loader2 } from "lucide-react";

interface QuickOrderSheetProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  link: string;
  onPlaced?: () => void;
}

export function QuickOrderSheet({ open, onOpenChange, link, onPlaced }: QuickOrderSheetProps) {
  const [views, setViews] = useState(5000);
  const [likes, setLikes] = useState(500);
  const [comments, setComments] = useState(0);
  const [drip, setDrip] = useState(0);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!link) return toast.error("Missing link");
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("instagram-place-engagement", {
        body: { link, views, likes, comments, drip_minutes: drip, source: "web" },
      });
      if (error) throw error;
      if ((data as any)?.error) throw new Error((data as any).error);
      toast.success(`Order #${(data as any).order_number} placed · ₹${(data as any).charged_inr}`);
      onOpenChange(false);
      onPlaced?.();
    } catch (e: any) {
      toast.error(e?.message ?? "Failed to place order");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-3xl bg-[#ffffff] border-border max-h-[85vh] overflow-y-auto">
        <SheetHeader>
          <SheetTitle className="text-white flex items-center gap-2"><Rocket className="w-5 h-5 text-primary" /> Boost this post</SheetTitle>
          <SheetDescription className="text-muted-foreground text-xs break-all">{link}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-4 mt-4">
          <div>
            <Label className="text-muted-foreground">Views</Label>
            <Input type="number" min={0} value={views} onChange={(e) => setViews(Math.max(0, Number(e.target.value) || 0))} />
          </div>
          <div>
            <Label className="text-muted-foreground">Likes</Label>
            <Input type="number" min={0} value={likes} onChange={(e) => setLikes(Math.max(0, Number(e.target.value) || 0))} />
          </div>
          <div>
            <Label className="text-muted-foreground">Comments</Label>
            <Input type="number" min={0} value={comments} onChange={(e) => setComments(Math.max(0, Number(e.target.value) || 0))} />
          </div>
          <div>
            <Label className="text-muted-foreground">Drip (minutes, 0 = instant)</Label>
            <Input type="number" min={0} value={drip} onChange={(e) => setDrip(Math.max(0, Number(e.target.value) || 0))} />
          </div>
          <Button onClick={submit} disabled={busy} className="h-11 bg-gradient-to-b from-primary to-primary">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : "Place Order"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
