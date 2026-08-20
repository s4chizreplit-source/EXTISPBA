import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { useNavigate, Link as RouterLink } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCurrency } from "@/hooks/useCurrency";
import { useGlobalMarkup } from "@/hooks/useGlobalMarkup";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format, formatDistanceToNow } from "date-fns";
import {
  Loader2, Rocket, Trash2, Pencil, Link as LinkIcon, AlertCircle,
  Upload, Download, Search, RefreshCw, CheckCircle2, XCircle, Clock,
  FileText, BarChart3, ExternalLink, Eye, Package, Heart, MessageCircle,
  Share2, Bookmark,
} from "lucide-react";

// ---------- Types ----------
type MetricKey = "likes" | "comments" | "shares" | "saves";
const METRIC_KEYS: MetricKey[] = ["likes", "comments", "shares", "saves"];
const METRIC_ICONS: Record<MetricKey, any> = {
  likes: Heart, comments: MessageCircle, shares: Share2, saves: Bookmark,
};

type TimeframeType = "24h" | "3d" | "7d" | "14d" | "custom";

interface MetricCfg { enabled: boolean; qty: number }

interface CardData {
  id: string;
  link: string;
  baseQty: number;                          // views qty
  metrics: Record<MetricKey, MetricCfg>;
  timeframe: TimeframeType;
  customDate?: string;
}

// ---------- Helpers ----------
const isValidUrl = (s: string) => {
  try { const u = new URL(s.trim()); return u.protocol === "http:" || u.protocol === "https:"; }
  catch { return false; }
};
const timeframeHours = (t: TimeframeType, customDate?: string): number => {
  if (t === "24h") return 24;
  if (t === "3d") return 72;
  if (t === "7d") return 168;
  if (t === "14d") return 336;
  if (t === "custom" && customDate) {
    const diff = (new Date(customDate).getTime() - Date.now()) / 3600000;
    return Math.max(1, Math.min(720, Math.round(diff)));
  }
  return 24;
};
const truncate = (s: string, n = 50) => (s.length > n ? s.slice(0, n) + "…" : s);

const parseCsvOrTxt = (text: string): string[] => {
  const out: string[] = [];
  text.split(/\r?\n/).forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const cells = line.split(/[,;\t]/).map((c) => c.trim().replace(/^["']|["']$/g, ""));
    const urlCell = cells.find((c) => /^https?:\/\//i.test(c));
    if (urlCell) out.push(urlCell);
    else if (/^https?:\/\//i.test(line)) out.push(line);
  });
  return out;
};

const STATUS_BADGE: Record<string, { color: string; icon: any }> = {
  processing: { color: "bg-blue-100 text-blue-700 border-blue-200", icon: Loader2 },
  completed: { color: "bg-green-100 text-green-700 border-green-200", icon: CheckCircle2 },
  partial: { color: "bg-amber-100 text-amber-700 border-amber-200", icon: AlertCircle },
  failed: { color: "bg-red-100 text-red-700 border-red-200", icon: XCircle },
};

// ---------- Page ----------
export default function MassOrder() {
  const navigate = useNavigate();
  const { user, wallet, refreshWallet, isAdmin } = useAuth();
  const { formatPrice } = useCurrency();
  const { applyMarkup } = useGlobalMarkup();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [activeTab, setActiveTab] = useState<"create" | "batches">("create");

  // ---- create form ----
  const [campaignName, setCampaignName] = useState("");
  const [selectedBundleId, setSelectedBundleId] = useState<string>("");
  const [linksText, setLinksText] = useState("");
  const [baseQty, setBaseQty] = useState<number>(10000);
  const [defaultMetrics, setDefaultMetrics] = useState<Record<MetricKey, MetricCfg>>({
    likes: { enabled: false, qty: 300 },
    comments: { enabled: false, qty: 10 },
    shares: { enabled: false, qty: 50 },
    saves: { enabled: false, qty: 80 },
  });
  const [timeframe, setTimeframe] = useState<TimeframeType>("24h");
  const [customDate, setCustomDate] = useState<string>("");
  const [overrides, setOverrides] = useState<Record<string, Partial<CardData>>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // ---- batches tab ----
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [viewingBatchId, setViewingBatchId] = useState<string | null>(null);

  // ---------- Data: bundles (all platforms, user picks) ----------
  const { data: bundles } = useQuery({
    queryKey: ["mass-order-bundles-all"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("engagement_bundles")
        .select(`*, items:bundle_items(*, service:services(id, name, price, min_quantity))`)
        .eq("is_active", true)
        .order("sort_order");
      if (error) throw error;
      return data as any[];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Auto-select first bundle once loaded
  useEffect(() => {
    if (!selectedBundleId && bundles && bundles.length > 0) {
      setSelectedBundleId(bundles[0].id);
    }
  }, [bundles, selectedBundleId]);

  const bundle = useMemo(
    () => bundles?.find((b) => b.id === selectedBundleId) ?? null,
    [bundles, selectedBundleId]
  );

  const serviceMap = useMemo(() => {
    const m: Record<string, { serviceId: string | null; pricePerK: number; minQty: number }> = {};
    bundle?.items?.forEach((it: any) => {
      const pricePerK = it.price_per_k != null && Number(it.price_per_k) > 0
        ? Number(it.price_per_k) : (it.service?.price ?? 0);
      m[it.engagement_type] = {
        serviceId: it.service?.id ?? it.service_id ?? null,
        pricePerK,
        minQty: it.service?.min_quantity ?? 0,
      };
    });
    return m;
  }, [bundle]);

  // ---------- Data: batches ----------
  const { data: batches, refetch: refetchBatches, isFetching: batchesLoading } = useQuery({
    queryKey: ["mass-order-batches", user?.id],
    queryFn: async () => {
      if (!user) return [];
      const { data, error } = await supabase
        .from("mass_order_batches")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data as any[];
    },
    enabled: !!user,
    staleTime: 10 * 1000,
  });

  const { data: viewingItems } = useQuery({
    queryKey: ["mass-order-batch-items", viewingBatchId],
    queryFn: async () => {
      if (!viewingBatchId) return [];
      const { data, error } = await supabase
        .from("mass_order_batch_items")
        .select("*")
        .eq("batch_id", viewingBatchId)
        .order("created_at");
      if (error) throw error;
      return data as any[];
    },
    enabled: !!viewingBatchId,
  });
  const viewingBatch = batches?.find((b) => b.id === viewingBatchId);

  // ---------- Parse links ----------
  const parsedLinks = useMemo(
    () => linksText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    [linksText]
  );
  const linkValidity = useMemo(() => parsedLinks.map(isValidUrl), [parsedLinks]);
  const validLinks = useMemo(
    () => parsedLinks.filter((_, i) => linkValidity[i]),
    [parsedLinks, linkValidity]
  );

  // build CardData for each link, using overrides or defaults
  const cards: CardData[] = useMemo(() => {
    return validLinks.map((link, idx) => {
      const id = `${idx}-${link}`;
      const ov = overrides[id] || {};
      return {
        id, link,
        baseQty: ov.baseQty ?? baseQty,
        metrics: ov.metrics ?? defaultMetrics,
        timeframe: ov.timeframe ?? timeframe,
        customDate: ov.customDate ?? customDate,
      };
    });
  }, [validLinks, overrides, baseQty, defaultMetrics, timeframe, customDate]);

  const cardCost = useCallback((c: CardData) => {
    let total = 0;
    const sv = serviceMap["views"];
    if (sv) total += (c.baseQty / 1000) * applyMarkup(sv.pricePerK);
    METRIC_KEYS.forEach((k) => {
      if (!c.metrics[k]?.enabled) return;
      const s = serviceMap[k];
      if (s) total += (c.metrics[k].qty / 1000) * applyMarkup(s.pricePerK);
    });
    return total;
  }, [serviceMap, applyMarkup]);

  const totalCost = useMemo(() => cards.reduce((s, c) => s + cardCost(c), 0), [cards, cardCost]);

  const errors = useMemo(() => {
    const list: string[] = [];
    if (!bundle) list.push("Pehle ek bundle select karo.");
    if (cards.length === 0) list.push("Kam se kam 1 valid link daalo.");
    if (parsedLinks.some((_, i) => !linkValidity[i])) list.push("Kuch links invalid hain (http/https chahiye).");
    if (new Set(validLinks).size !== validLinks.length) list.push("Duplicate links hain.");
    if (baseQty <= 0) list.push("Base quantity invalid.");
    if (timeframe === "custom" && !customDate) list.push("Custom deadline date select karo.");
    if (bundle && !serviceMap["views"]) list.push(`Is bundle me "views" service nahi hai.`);
    if (wallet && wallet.balance < totalCost) list.push(`Insufficient balance. Need ${formatPrice(totalCost)}, have ${formatPrice(wallet.balance)}.`);
    return list;
  }, [bundle, cards, parsedLinks, linkValidity, validLinks, baseQty, timeframe, customDate, serviceMap, wallet, totalCost, formatPrice]);

  const canSubmit = errors.length === 0 && cards.length > 0 && !submitting;

  // ---------- File upload ----------
  const handleFileUpload = async (file: File) => {
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "File too large", description: "Max 5MB", variant: "destructive" });
      return;
    }
    const text = await file.text();
    const parsed = parseCsvOrTxt(text);
    if (parsed.length === 0) {
      toast({ title: "No URLs found", description: "File must contain http(s) URLs.", variant: "destructive" });
      return;
    }
    const existing = new Set(parsedLinks);
    const merged = [...parsedLinks];
    parsed.forEach((u) => { if (!existing.has(u)) { merged.push(u); existing.add(u); } });
    setLinksText(merged.join("\n"));
    toast({ title: "Imported", description: `${parsed.length} URLs from ${file.name}` });
  };

  // ---------- Submit ----------
  const handleSubmitAll = async () => {
    if (!user || !canSubmit || !bundle) return;
    setSubmitting(true);
    setProgress({ done: 0, total: cards.length });


    const { data: batchRow, error: batchErr } = await supabase
      .from("mass_order_batches")
      .insert({
        user_id: user.id,
        name: campaignName.trim() || `Batch ${new Date().toLocaleString()}`,
        platform: bundle.platform,
        total_count: cards.length,
        status: "processing",
        total_price: totalCost,
      })
      .select()
      .single();

    if (batchErr || !batchRow) {
      toast({ title: "Failed to start batch", description: batchErr?.message, variant: "destructive" });
      setSubmitting(false);
      return;
    }

    const itemsToInsert = cards.map((c) => ({
      batch_id: batchRow.id,
      user_id: user.id,
      link: c.link,
      status: "pending",
      price: cardCost(c),
      payload: {
        baseQty: c.baseQty,
        metrics: Object.fromEntries(
          METRIC_KEYS.filter((k) => c.metrics[k]?.enabled).map((k) => [k, c.metrics[k].qty])
        ),
        hours: timeframeHours(c.timeframe, c.customDate),
        timeframe: c.timeframe,
      },
    }));
    const { data: insertedItems } = await supabase
      .from("mass_order_batch_items")
      .insert(itemsToInsert)
      .select();
    const itemByLink = new Map<string, any>();
    (insertedItems || []).forEach((it: any) => itemByLink.set(it.link, it));

    let okCount = 0, failCount = 0;

    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const itemRow = itemByLink.get(c.link);
      try {
        const engagements: any[] = [];
        const hours = timeframeHours(c.timeframe, c.customDate);
        const pushType = (type: string, qty: number) => {
          const s = serviceMap[type];
          if (!s || !s.serviceId || qty <= 0) return;
          const price = (qty / 1000) * applyMarkup(s.pricePerK);
          engagements.push({
            type, quantity: qty, price, service_id: s.serviceId,
            time_limit_hours: hours,
            variance_percent: 15, peak_hours_enabled: true,
          });
        };
        pushType("views", c.baseQty);
        METRIC_KEYS.forEach((k) => { if (c.metrics[k]?.enabled) pushType(k, c.metrics[k].qty); });
        const totalPrice = engagements.reduce((s, e) => s + e.price, 0);

        const { data, error } = await supabase.functions.invoke("process-engagement-order", {
          body: {
            user_id: user.id,
            bundle_id: bundle.id,
            link: c.link,
            campaign_name: campaignName.trim() || null,
            base_quantity: c.baseQty,
            total_price: totalPrice,
            is_organic_mode: true,
            engagements,
          },
        });

        if (error) {
          let message = (error as any)?.message || "Order failed";
          const ctx = (error as any)?.context;
          if (ctx && typeof ctx.text === "function") {
            try {
              const text = await ctx.text();
              const parsed = JSON.parse(text);
              message = parsed?.error || parsed?.message || text;
            } catch { /* ignore */ }
          }
          throw new Error(message);
        }
        if ((data as any)?.error) throw new Error((data as any).error);

        okCount++;
        if (itemRow) {
          await supabase.from("mass_order_batch_items").update({
            status: "success",
            engagement_order_id: (data as any)?.order_id,
            engagement_order_number: (data as any)?.order_number,
          }).eq("id", itemRow.id);
        }
      } catch (e: any) {
        failCount++;
        if (itemRow) {
          await supabase.from("mass_order_batch_items").update({
            status: "failed",
            error_message: e?.message?.slice(0, 500) || "Failed",
          }).eq("id", itemRow.id);
        }
      }

      setProgress({ done: i + 1, total: cards.length });
      await supabase.from("mass_order_batches").update({
        success_count: okCount,
        failed_count: failCount,
      }).eq("id", batchRow.id);
      refreshWallet();
    }

    const finalStatus = failCount === 0 ? "completed" : okCount === 0 ? "failed" : "partial";
    await supabase.from("mass_order_batches").update({ status: finalStatus }).eq("id", batchRow.id);

    setSubmitting(false);
    queryClient.invalidateQueries({ queryKey: ["mass-order-batches"] });

    toast({
      title: finalStatus === "completed" ? "🚀 Campaign Complete" : `${okCount} ok, ${failCount} failed`,
      description: `"${batchRow.name}" finished.`,
      variant: finalStatus === "failed" ? "destructive" : "default",
    });

    if (finalStatus !== "failed") {
      setLinksText("");
      setCampaignName("");
      setOverrides({});
    }
    setActiveTab("batches");
  };

  // ---------- CSV download ----------
  const downloadBatchCsv = async (batchId: string, batchName: string) => {
    const { data } = await supabase.from("mass_order_batch_items").select("*").eq("batch_id", batchId).order("created_at");
    if (!data || data.length === 0) {
      toast({ title: "Empty batch", variant: "destructive" });
      return;
    }
    const header = ["Link", "Status", "Order #", "Price", "Base Qty", "Metrics", "Hours", "Error"];
    const rows = data.map((it: any) => {
      const p = it.payload || {};
      const metrics = Object.entries(p.metrics || {}).map(([k, v]) => `${k}:${v}`).join("|");
      return [
        it.link, it.status, it.engagement_order_number ?? "", it.price ?? "",
        p.baseQty ?? p.views ?? "", metrics, p.hours ?? "", (it.error_message ?? "").replace(/[\r\n,]/g, " "),
      ];
    });
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${batchName.replace(/[^a-z0-9]/gi, "_")}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  // ---------- Edit helpers ----------
  const editingCard = cards.find((c) => c.id === editingId) || null;
  const updateOverride = (id: string, patch: Partial<CardData>) =>
    setOverrides((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  const resetOverride = (id: string) =>
    setOverrides((prev) => { const n = { ...prev }; delete n[id]; return n; });
  const removeLink = (link: string) =>
    setLinksText((t) => t.split(/\r?\n/).filter((l) => l.trim() !== link).join("\n"));

  // ---------- Batches stats ----------
  const stats = useMemo(() => {
    const s = { total: 0, completed: 0, processing: 0, failed: 0, partial: 0 };
    (batches || []).forEach((b: any) => {
      s.total++;
      if (b.status === "completed") s.completed++;
      else if (b.status === "processing") s.processing++;
      else if (b.status === "failed") s.failed++;
      else if (b.status === "partial") s.partial++;
    });
    return s;
  }, [batches]);
  const successRate = stats.total ? Math.round((stats.completed / stats.total) * 100) : 0;

  const filteredBatches = useMemo(() => {
    return (batches || []).filter((b: any) => {
      if (statusFilter !== "all" && b.status !== statusFilter) return false;
      if (search && !(b.name || "").toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [batches, statusFilter, search]);

  if (!user) { navigate("/auth"); return null; }

  return (
    <DashboardLayout>
      <div className="space-y-4 max-w-3xl mx-auto pb-24 lg:pb-6">
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList className="grid grid-cols-2 w-full">
            <TabsTrigger value="create"><Rocket className="w-4 h-4 mr-1" /> Create</TabsTrigger>
            <TabsTrigger value="batches"><Clock className="w-4 h-4 mr-1" /> Batches</TabsTrigger>
          </TabsList>

          {/* ---------- CREATE TAB ---------- */}
          <TabsContent value="create" className="mt-4 space-y-4">
            {/* Hero */}
            <Card>
              <CardContent className="pt-5 flex gap-3">
                <div className="w-10 h-10 rounded-lg bg-orange-50 flex items-center justify-center shrink-0">
                  <Rocket className="w-5 h-5 text-orange-500" />
                </div>
                <div>
                  <h1 className="text-lg font-bold">Mass Order — Bulk Engagement</h1>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Multiple links ek saath order karo. Paste karo ya CSV/TXT file upload karo,
                    har link customize karo, batch me submit karo aur history me track karo.
                  </p>
                </div>
              </CardContent>
            </Card>

            {/* Bundle + Campaign Name */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Package className="w-4 h-4" /> Apna Bundle
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Select value={selectedBundleId} onValueChange={setSelectedBundleId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a bundle" />
                  </SelectTrigger>
                  <SelectContent>
                    {(bundles || []).map((b: any) => (
                      <SelectItem key={b.id} value={b.id}>
                        {b.name} ({b.platform} • {b.items?.length || 0} items)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <div>
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Campaign Name (Optional)
                  </Label>
                  <Input
                    value={campaignName}
                    onChange={(e) => setCampaignName(e.target.value)}
                    placeholder="e.g. Diwali Reels Mega Campaign 2026"
                    className="mt-1.5"
                  />
                </div>
              </CardContent>
            </Card>

            {/* Links */}
            <Card>
              <CardHeader className="pb-3 flex flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base flex items-center gap-2">
                  <LinkIcon className="w-4 h-4" /> Links
                </CardTitle>
                <Button size="sm" variant="outline" type="button"
                  onClick={() => fileInputRef.current?.click()}>
                  <Upload className="w-3.5 h-3.5 mr-1.5" /> Upload CSV / TXT
                </Button>
                <input ref={fileInputRef} type="file" accept=".csv,.txt,text/csv,text/plain"
                  className="hidden"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFileUpload(f); e.target.value = ""; }} />
              </CardHeader>
              <CardContent className="space-y-3">
                <Textarea
                  value={linksText}
                  onChange={(e) => setLinksText(e.target.value)}
                  placeholder={"Ek line par ek link.\nhttps://instagram.com/p/abc\nhttps://instagram.com/p/xyz\n\nYa CSV upload karo (first column = link)."}
                  rows={7}
                  className="font-mono text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  {validLinks.length} valid link(s)
                  {parsedLinks.length !== validLinks.length && (
                    <span className="text-amber-600 ml-1">
                      ({parsedLinks.length - validLinks.length} invalid)
                    </span>
                  )}
                </p>

                <div>
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Default Base Quantity (Views)
                  </Label>
                  <Input
                    type="number" min={1}
                    value={baseQty}
                    onChange={(e) => setBaseQty(Math.max(1, Number(e.target.value) || 0))}
                    className="mt-1.5"
                  />
                </div>

                <div>
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Default Timeframe
                  </Label>
                  <Select value={timeframe} onValueChange={(v) => setTimeframe(v as TimeframeType)}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24h">Under 24 hours</SelectItem>
                      <SelectItem value="3d">1–3 days</SelectItem>
                      <SelectItem value="7d">3–7 days</SelectItem>
                      <SelectItem value="14d">7–14 days</SelectItem>
                      <SelectItem value="custom">Custom date</SelectItem>
                    </SelectContent>
                  </Select>
                  {timeframe === "custom" && (
                    <Input type="datetime-local" className="mt-2"
                      value={customDate} onChange={(e) => setCustomDate(e.target.value)} />
                  )}
                </div>

                {/* Default metric toggles */}
                <div className="space-y-1.5 pt-1">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Default Extra Engagement (Optional)
                  </Label>
                  <div className="grid grid-cols-2 gap-2">
                    {METRIC_KEYS.map((k) => {
                      const Icon = METRIC_ICONS[k];
                      return (
                        <label key={k}
                          className="flex items-center gap-2 border rounded-lg px-2 py-1.5 cursor-pointer hover:bg-muted/30">
                          <Checkbox
                            checked={defaultMetrics[k].enabled}
                            onCheckedChange={(v) => setDefaultMetrics((m) => ({
                              ...m, [k]: { ...m[k], enabled: !!v },
                            }))}
                          />
                          <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                          <span className="capitalize text-xs flex-1">{k}</span>
                          {defaultMetrics[k].enabled && (
                            <Input
                              type="number" min={1}
                              value={defaultMetrics[k].qty}
                              onChange={(e) => setDefaultMetrics((m) => ({
                                ...m, [k]: { ...m[k], qty: Math.max(1, Number(e.target.value) || 0) },
                              }))}
                              className="h-7 w-20 text-xs"
                              onClick={(e) => e.stopPropagation()}
                            />
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>

                <p className="text-xs text-muted-foreground border-t pt-2">
                  Defaults sirf naye links par apply hote hain. Existing rows ko edit karke per-link override karo.
                </p>
              </CardContent>
            </Card>

            {/* Per-link preview cards */}
            {cards.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span>Preview ({cards.length})</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      Click edit to override per link
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  {cards.map((c) => (
                    <div key={c.id} className="border rounded-lg p-3">
                      <a href={c.link} target="_blank" rel="noreferrer"
                        className="text-xs text-blue-600 hover:underline break-all">
                        {truncate(c.link, 70)}
                      </a>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 text-xs">
                        <span><span className="text-muted-foreground">Views:</span> <strong>{c.baseQty.toLocaleString()}</strong></span>
                        {METRIC_KEYS.map((k) => c.metrics[k]?.enabled && (
                          <span key={k}>
                            <span className="text-muted-foreground capitalize">{k}:</span>{" "}
                            <strong>{c.metrics[k].qty.toLocaleString()}</strong>
                          </span>
                        ))}
                        <span className="ml-auto font-semibold">{formatPrice(cardCost(c))}</span>
                      </div>
                      <div className="flex gap-2 mt-2">
                        <Button size="sm" variant="outline" onClick={() => setEditingId(c.id)}>
                          <Pencil className="w-3 h-3 mr-1" /> Edit
                        </Button>
                        <Button size="sm" variant="ghost" className="text-red-600"
                          onClick={() => removeLink(c.link)}>
                          <Trash2 className="w-3 h-3 mr-1" /> Remove
                        </Button>
                      </div>
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Errors */}
            {errors.length > 0 && (
              <Card className="border-amber-300 bg-amber-50">
                <CardContent className="pt-4 space-y-1">
                  {errors.map((e, i) => (
                    <p key={i} className="text-xs text-amber-900 flex items-start gap-1">
                      <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" /> {e}
                    </p>
                  ))}
                </CardContent>
              </Card>
            )}

            {/* Progress */}
            {submitting && progress && (
              <Card>
                <CardContent className="pt-4">
                  <div className="flex items-center justify-between text-sm mb-2">
                    <span>Submitting…</span>
                    <strong>{progress.done}/{progress.total}</strong>
                  </div>
                  <Progress value={(progress.done / Math.max(1, progress.total)) * 100} />
                </CardContent>
              </Card>
            )}

            {/* Submit footer */}
            <Card>
              <CardContent className="pt-4 space-y-3">
                <p className="text-sm text-center text-muted-foreground">
                  {cards.length} order(s) ready • Total{" "}
                  <strong className="text-foreground">{formatPrice(totalCost)}</strong>
                </p>
                <Button onClick={handleSubmitAll} disabled={!canSubmit}
                  className="w-full h-12 text-base font-semibold">
                  {submitting && progress ? (
                    <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Submitting {progress.done}/{progress.total}…</>
                  ) : (
                    <><Rocket className="w-4 h-4 mr-2" /> Submit All Orders</>
                  )}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ---------- BATCHES TAB ---------- */}
          <TabsContent value="batches" className="mt-4 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Total Batches" value={stats.total} color="text-foreground" />
              <StatCard label="Completed" value={stats.completed} color="text-green-600" />
              <StatCard label="Processing" value={stats.processing} color="text-blue-600" />
              <StatCard label="Failed / Partial" value={stats.failed + stats.partial} color="text-red-600" />
              <StatCard label="Success Rate" value={`${successRate}%`} color="text-orange-600" />
            </div>

            <Card>
              <CardContent className="pt-4 space-y-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                  <Input placeholder="Search by campaign name..." value={search}
                    onChange={(e) => setSearch(e.target.value)} className="pl-9" />
                </div>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="processing">Processing</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="partial">Partial</SelectItem>
                    <SelectItem value="failed">Failed</SelectItem>
                  </SelectContent>
                </Select>
                <Button variant="outline" className="w-full" onClick={() => refetchBatches()}>
                  <RefreshCw className={`w-4 h-4 mr-1 ${batchesLoading ? "animate-spin" : ""}`} /> Refresh
                </Button>
              </CardContent>
            </Card>

            {filteredBatches.length === 0 ? (
              <Card className="p-12 text-center text-muted-foreground">
                <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-40" />
                No batches yet. Create one from the "Create" tab.
              </Card>
            ) : (
              <div className="space-y-2">
                {filteredBatches.map((b: any) => {
                  const cfg = STATUS_BADGE[b.status] || STATUS_BADGE.processing;
                  const Icon = cfg.icon;
                  const okRate = b.total_count ? Math.round((b.success_count / b.total_count) * 100) : 0;
                  return (
                    <Card key={b.id}>
                      <CardContent className="pt-4 space-y-2">
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <h3 className="font-semibold truncate flex-1 min-w-0">{b.name}</h3>
                          <Badge className={cfg.color}>
                            <Icon className={`w-3 h-3 mr-1 ${b.status === "processing" ? "animate-spin" : ""}`} />
                            {b.status}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {format(new Date(b.created_at), "dd/MM/yyyy, HH:mm:ss")}
                          {" • "}{b.total_count} links
                          {" • "}{formatPrice(b.total_price || 0)}
                        </p>
                        <p className="text-xs">
                          <span className="text-green-700 font-semibold">{b.success_count} success</span>
                          <span className="text-muted-foreground"> ({okRate}% rate)</span>
                          {b.failed_count > 0 && (
                            <span className="text-red-600 ml-2">{b.failed_count} failed</span>
                          )}
                        </p>
                        <div className="flex gap-2 pt-1">
                          <Button size="sm" variant="outline" className="flex-1"
                            onClick={() => setViewingBatchId(b.id)}>
                            <Eye className="w-3 h-3 mr-1" /> View
                          </Button>
                          <Button size="sm" variant="outline" className="flex-1"
                            onClick={() => downloadBatchCsv(b.id, b.name)}>
                            <Download className="w-3 h-3 mr-1" /> CSV
                          </Button>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* ---------- Edit Order Dialog ---------- */}
      <Dialog open={!!editingCard} onOpenChange={(o) => !o && setEditingId(null)}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Edit Order</DialogTitle></DialogHeader>
          {editingCard && (
            <div className="space-y-3">
              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">Link</Label>
                <Input value={editingCard.link} readOnly className="text-xs mt-1 bg-muted/40" />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                    Base Quantity
                  </Label>
                  <Input type="number" min={1}
                    value={editingCard.baseQty}
                    onChange={(e) => updateOverride(editingCard.id, {
                      baseQty: Math.max(1, Number(e.target.value) || 1),
                    })}
                    className="mt-1" />
                </div>
                <div>
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Timeframe</Label>
                  <Select value={editingCard.timeframe}
                    onValueChange={(v) => updateOverride(editingCard.id, { timeframe: v as TimeframeType })}>
                    <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24h">Under 24 hours</SelectItem>
                      <SelectItem value="3d">1–3 days</SelectItem>
                      <SelectItem value="7d">3–7 days</SelectItem>
                      <SelectItem value="14d">7–14 days</SelectItem>
                      <SelectItem value="custom">Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {editingCard.timeframe === "custom" && (
                <Input type="datetime-local"
                  value={editingCard.customDate || ""}
                  onChange={(e) => updateOverride(editingCard.id, { customDate: e.target.value })} />
              )}

              <div>
                <Label className="text-xs uppercase tracking-wide text-muted-foreground">
                  Engagement Types & Quantities
                </Label>
                <div className="mt-2 space-y-2">
                  {/* Views always on */}
                  <div className="flex items-center gap-3 border rounded-lg px-3 py-2 bg-muted/30">
                    <Checkbox checked disabled />
                    <Eye className="w-3.5 h-3.5 text-muted-foreground" />
                    <span className="text-sm flex-1">Views</span>
                    <Input type="number" min={1} value={editingCard.baseQty}
                      onChange={(e) => updateOverride(editingCard.id, {
                        baseQty: Math.max(1, Number(e.target.value) || 1),
                      })}
                      className="h-8 w-28 text-sm" />
                  </div>
                  {METRIC_KEYS.map((k) => {
                    const Icon = METRIC_ICONS[k];
                    const m = editingCard.metrics[k];
                    return (
                      <div key={k} className="flex items-center gap-3 border rounded-lg px-3 py-2">
                        <Checkbox
                          checked={m.enabled}
                          onCheckedChange={(v) => updateOverride(editingCard.id, {
                            metrics: { ...editingCard.metrics, [k]: { ...m, enabled: !!v } },
                          })}
                        />
                        <Icon className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="text-sm capitalize flex-1">{k}</span>
                        <Input type="number" min={1} value={m.qty}
                          disabled={!m.enabled}
                          onChange={(e) => updateOverride(editingCard.id, {
                            metrics: {
                              ...editingCard.metrics,
                              [k]: { ...m, qty: Math.max(1, Number(e.target.value) || 1) },
                            },
                          })}
                          className="h-8 w-28 text-sm" />
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground mt-2">
                  Tip: har service ki quantity yahan independently set kar sakte ho (views, likes, shares — sab alag).
                </p>
              </div>

              {/* Cost breakdown */}
              <div className="border rounded-lg p-3 bg-muted/30 text-sm space-y-1">
                {(() => {
                  const rows: { label: string; qty: number; cost: number }[] = [];
                  const sv = serviceMap["views"];
                  if (sv) rows.push({ label: "Views", qty: editingCard.baseQty, cost: (editingCard.baseQty / 1000) * applyMarkup(sv.pricePerK) });
                  METRIC_KEYS.forEach((k) => {
                    if (!editingCard.metrics[k]?.enabled) return;
                    const s = serviceMap[k];
                    if (s) rows.push({
                      label: k[0].toUpperCase() + k.slice(1),
                      qty: editingCard.metrics[k].qty,
                      cost: (editingCard.metrics[k].qty / 1000) * applyMarkup(s.pricePerK),
                    });
                  });
                  const total = rows.reduce((s, r) => s + r.cost, 0);
                  return (
                    <>
                      {rows.map((r) => (
                        <div key={r.label} className="flex items-center justify-between text-xs">
                          <span>{r.label}</span>
                          <span>{r.qty.toLocaleString()} · {formatPrice(r.cost)}</span>
                        </div>
                      ))}
                      <div className="flex items-center justify-between border-t pt-1 mt-1 font-semibold">
                        <span>Total</span>
                        <span>{formatPrice(total)}</span>
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          )}
          <DialogFooter className="flex-col sm:flex-col gap-2 sm:space-x-0">
            <Button onClick={() => setEditingId(null)} className="w-full">Save</Button>
            <Button variant="outline" className="w-full"
              onClick={() => { if (editingCard) resetOverride(editingCard.id); setEditingId(null); }}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------- View Batch Dialog ---------- */}
      <Dialog open={!!viewingBatchId} onOpenChange={(o) => !o && setViewingBatchId(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 flex-wrap">
              {viewingBatch?.name}
              {viewingBatch && (
                <Badge className={STATUS_BADGE[viewingBatch.status]?.color}>{viewingBatch.status}</Badge>
              )}
            </DialogTitle>
            {viewingBatch && (
              <p className="text-xs text-muted-foreground">
                {viewingBatch.platform} • {viewingBatch.success_count}/{viewingBatch.total_count} ok
                {" • "}{viewingBatch.failed_count} failed • {format(new Date(viewingBatch.created_at), "PPp")}
              </p>
            )}
          </DialogHeader>
          <div className="overflow-y-auto flex-1 space-y-2 -mx-2 px-2">
            {(viewingItems || []).map((it: any) => {
              const cfg = STATUS_BADGE[it.status] || { color: "bg-gray-100 text-gray-700", icon: Clock };
              const Icon = cfg.icon;
              return (
                <div key={it.id} className="border rounded-lg p-3 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <a href={it.link} target="_blank" rel="noreferrer"
                      className="text-xs text-blue-600 hover:underline break-all flex-1">
                      {truncate(it.link, 80)}
                    </a>
                    <Badge className={cfg.color}>
                      <Icon className="w-3 h-3 mr-1" /> {it.status}
                    </Badge>
                  </div>
                  {it.engagement_order_number && (
                    <RouterLink to={`/engagement-orders/${it.engagement_order_number}`}
                      className="text-xs text-blue-600 hover:underline flex items-center gap-1 mt-1">
                      Order #{it.engagement_order_number} <ExternalLink className="w-3 h-3" />
                    </RouterLink>
                  )}
                  {it.error_message && (
                    <p className="text-xs text-red-600 mt-1">⚠ {it.error_message}</p>
                  )}
                </div>
              );
            })}
          </div>
          <DialogFooter>
            {viewingBatch && (
              <Button variant="outline" onClick={() => downloadBatchCsv(viewingBatch.id, viewingBatch.name)}>
                <Download className="w-4 h-4 mr-1" /> Download CSV
              </Button>
            )}
            <Button onClick={() => setViewingBatchId(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

function StatCard({ label, value, color }: { label: string; value: any; color: string }) {
  return (
    <Card>
      <CardContent className="pt-4">
        <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      </CardContent>
    </Card>
  );
}
