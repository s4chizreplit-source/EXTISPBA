import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, TrendingUp, Zap, Wallet, Radio, AlertTriangle } from "lucide-react";

import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { TooltipProvider } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(path, { credentials: "include", ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any)?.error || r.statusText);
  return data;
}

const INR_RATE = 83.5;
const inr = (n: number) => `₹${Math.round((n || 0) * INR_RATE).toLocaleString("en-IN")}`;
const inrFromAny = (n: number, currency?: string | null) => {
  const code = (currency || "").toUpperCase();
  if (code === "INR") return `₹${Math.round(n || 0).toLocaleString("en-IN")}`;
  return inr(n);
};
const num = (n: number) => (n || 0).toLocaleString("en-IN");
const usd = (n: number) => `$${(n || 0).toFixed(2)}`;

type PlanRow = {
  provider_account_id: string;
  provider_id: string;
  provider_name: string;
  pending_runs: number;
  pending_user_usd: number;
  markup_percent: number;
};

type BreakdownRow = {
  provider_account_id: string;
  provider_id: string;
  provider_name: string;
  service_id: string;
  service_name: string;
  service_category: string | null;
  pending_runs: number;
  pending_quantity: number;
  pending_user_usd: number;
};

type ProviderAccount = {
  id: string;
  provider_id: string;
  name: string;
  is_active: boolean;
  balance: number | null;
  balance_currency: string | null;
  balance_checked_at: string | null;
  last_balance_error: string | null;
};

export default function AdminTopupPlan() {
  const queryClient = useQueryClient();
  const [checkingAll, setCheckingAll] = useState(false);
  const [liveConnected, setLiveConnected] = useState(false);

  const plan = useQuery({
    queryKey: ["topup-plan"],
    queryFn: async () => {
      const data = await apiFetch("/api/admin/topup-plan");
      const list = Array.isArray(data) ? data : (data?.plan ?? []);
      return list as PlanRow[];
    },
    refetchInterval: 60_000,
  });

  const breakdown = useQuery({
    queryKey: ["topup-breakdown"],
    queryFn: async () => {
      const data = await apiFetch("/api/admin/topup-breakdown");
      const list = Array.isArray(data) ? data : (data?.breakdown ?? []);
      return list as BreakdownRow[];
    },
    refetchInterval: 60_000,
  });

  const accounts = useQuery({
    queryKey: ["topup-provider-accounts"],
    queryFn: async () => {
      const data = await apiFetch("/api/admin/provider-accounts");
      const list = (Array.isArray(data) ? data : (data?.accounts ?? [])) as ProviderAccount[];
      return list.filter((a) => a.is_active).sort((a, b) => a.name.localeCompare(b.name));
    },
    refetchInterval: 60_000,
  });

  // Top pending users — computed server-side
  const topUsers = useQuery({
    queryKey: ["topup-top-users"],
    queryFn: async () => {
      const data = await apiFetch("/api/admin/topup-users");
      const list = Array.isArray(data) ? data : (data?.users ?? []);
      return list.map((l: any) => ({
        user_id: l.user_id,
        count: Number(l.count || 0),
        value: Number(l.value || 0),
        email: l.email || "—",
        name: l.name || "",
        wallet: Number(l.wallet || 0),
        deposited: Number(l.deposited || 0),
        spent: Number(l.spent || 0),
      }));
    },
    refetchInterval: 60_000,
  });

  // Polling replaces realtime; mark live once first plan load succeeds
  useEffect(() => {
    setLiveConnected(plan.isSuccess);
  }, [plan.isSuccess]);

  const checkAll = async () => {
    setCheckingAll(true);
    try {
      const res = (await apiFetch("/api/admin/provider-accounts/check-balances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "manual" }),
      })) as { checked?: number; results?: { name: string; error?: string }[] };
      const n = res?.checked ?? 0;
      const failed = (res?.results || []).filter((r) => r.error);
      // Pull the freshly written balances into the UI
      await Promise.all([accounts.refetch(), plan.refetch(), breakdown.refetch()]);
      if (failed.length > 0) {
        toast.error(`${failed.length} provider${failed.length === 1 ? "" : "s"} failed`, {
          description: failed.map((f) => `${f.name}: ${String(f.error)}`).join(" | "),
        });
      } else {
        toast.success(`Checked ${n} provider${n === 1 ? "" : "s"} live`);
      }
    } catch (e) {
      toast.error("Live balance check failed", { description: (e as Error).message });
    } finally {
      setCheckingAll(false);
    }
  };


  const refreshAll = () => {
    plan.refetch();
    breakdown.refetch();
    accounts.refetch();
    topUsers.refetch();
  };

  const planByAccount = useMemo(() => {
    const m = new Map<string, PlanRow>();
    (plan.data || []).forEach((r) => m.set(r.provider_account_id, r));
    return m;
  }, [plan.data]);

  const markup = plan.data?.[0]?.markup_percent ?? 0;

  // KPIs
  const totalPendingRuns = (plan.data || []).reduce((s, r) => s + Number(r.pending_runs || 0), 0);
  const totalPendingUsd = (plan.data || []).reduce((s, r) => s + Number(r.pending_user_usd || 0), 0);
  const totalProviderCostUsd = totalPendingUsd / (1 + Number(markup) / 100);
  // Convert live balance to USD-equivalent for comparability
  const totalBalanceUsd = (accounts.data || []).reduce((s, a) => {
    const bal = Number(a.balance || 0);
    if ((a.balance_currency || "").toUpperCase() === "INR") return s + bal / INR_RATE;
    return s + bal;
  }, 0);
  const shortUsd = totalProviderCostUsd - totalBalanceUsd;

  // Per-provider need vs balance rows
  const providerRows = useMemo(() => {
    return (accounts.data || []).map((a) => {
      const row = planByAccount.get(a.id);
      const userUsd = row ? Number(row.pending_user_usd) : 0;
      const needUsd = userUsd / (1 + Number(row?.markup_percent ?? markup) / 100);
      const balanceUsd =
        (a.balance_currency || "").toUpperCase() === "INR"
          ? Number(a.balance || 0) / INR_RATE
          : Number(a.balance || 0);
      const diff = balanceUsd - needUsd;
      return { a, needUsd, balanceUsd, diff };
    }).sort((x, y) => x.diff - y.diff);
  }, [accounts.data, planByAccount, markup]);

  // Service-wise pending totals grouped by category
  const serviceCategoryTotals = useMemo(() => {
    const m = new Map<string, { category: string; quantity: number; runs: number; userUsd: number }>();
    (breakdown.data || []).forEach((r) => {
      const cat = r.service_category || "Other";
      const cur = m.get(cat) || { category: cat, quantity: 0, runs: 0, userUsd: 0 };
      cur.quantity += Number(r.pending_quantity || 0);
      cur.runs += Number(r.pending_runs || 0);
      cur.userUsd += Number(r.pending_user_usd || 0);
      m.set(cat, cur);
    });
    return Array.from(m.values()).sort((a, b) => b.userUsd - a.userUsd);
  }, [breakdown.data]);

  const loading = plan.isLoading || breakdown.isLoading || accounts.isLoading;

  return (
    <DashboardLayout>
      <TooltipProvider delayDuration={200}>
        <div className="space-y-6">
          {/* Header */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Button asChild variant="ghost" size="sm">
                <Link to="/admin"><ArrowLeft className="h-4 w-4 mr-1" /> Admin</Link>
              </Button>
              <div>
                <h1 className="text-2xl font-bold flex items-center gap-2">
                  <TrendingUp className="h-6 w-6 text-primary" />
                  Provider Top-Up Plan
                </h1>
                <p className="text-sm text-muted-foreground">
                  One-click view of pending load vs. provider balances.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={cn(
                  "text-xs gap-1.5 border-transparent",
                  liveConnected ? "bg-success/10 text-success" : "bg-muted text-muted-foreground"
                )}
              >
                <span className="relative flex h-2 w-2">
                  {liveConnected && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
                  )}
                  <span className={cn("relative inline-flex h-2 w-2 rounded-full", liveConnected ? "bg-success" : "bg-muted-foreground/50")} />
                </span>
                {liveConnected ? "LIVE" : "Connecting…"}
              </Badge>
              <Button size="sm" variant="outline" onClick={refreshAll} disabled={loading}>
                <RefreshCw className={cn("h-4 w-4 mr-1", loading && "animate-spin")} />
                Refresh
              </Button>
              <Button size="sm" onClick={checkAll} disabled={checkingAll} className="gap-1">
                <Zap className={cn("h-4 w-4", checkingAll && "animate-pulse")} />
                {checkingAll ? "Checking…" : "Check All Balances"}
              </Button>
            </div>
          </div>

          {/* KPI cards — 4 tiles */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Card className="glass-card">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Pending Runs</div>
                <div className="text-2xl font-bold tabular-nums mt-1">{num(totalPendingRuns)}</div>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Provider Cost (₹)</div>
                <div className="text-2xl font-bold tabular-nums mt-1">{inr(totalProviderCostUsd)}</div>
              </CardContent>
            </Card>
            <Card className="glass-card">
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Current Balance (₹)</div>
                <div className="text-2xl font-bold tabular-nums mt-1 text-success">{inr(totalBalanceUsd)}</div>
              </CardContent>
            </Card>
            <Card className={cn("glass-card", shortUsd > 0 && "ring-1 ring-destructive/40")}>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">Short (₹)</div>
                <div className={cn("text-2xl font-bold tabular-nums mt-1", shortUsd > 0 ? "text-destructive" : "text-success")}>
                  {shortUsd > 0 ? `-${inr(shortUsd)}` : inr(0)}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Section 1: Per-Provider Balance vs Need */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4 text-primary" />
                Per-Provider Balance vs Need
                <Badge variant="outline" className="text-[10px] gap-1 ml-1">
                  <Radio className="h-3 w-3" /> Live
                </Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Har provider ka real-time balance, kitna lagne wala hai, aur kitna short ya extra hai.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {accounts.isLoading ? (
                <div className="p-4 space-y-2">
                  {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10" />)}
                </div>
              ) : providerRows.length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">No active provider accounts.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-muted-foreground border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-2">Provider</th>
                        <th className="text-right px-4 py-2">Need (₹)</th>
                        <th className="text-right px-4 py-2">Balance (₹)</th>
                        <th className="text-right px-4 py-2">Short / Extra</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providerRows.map(({ a, needUsd, balanceUsd, diff }) => {
                        const short = diff < 0;
                        return (
                          <tr key={a.id} className="border-b border-border/40 hover:bg-muted/30">
                            <td className="px-4 py-3">
                              <div className="font-medium">{a.name}</div>
                              <div className="text-[11px] text-muted-foreground">
                                {a.balance != null
                                  ? (() => {
                                      const bal = Number(a.balance);
                                      const cur = (a.balance_currency || "INR").toUpperCase();
                                      const inrVal = cur === "INR" ? bal : bal * 85;
                                      return `₹${Math.round(inrVal).toLocaleString("en-IN")}`;
                                    })()
                                  : "never checked"}
                                {a.last_balance_error && (
                                  <span className="inline-flex items-center gap-1 ml-2 text-destructive">
                                    <AlertTriangle className="h-3 w-3" /> error
                                  </span>
                                )}
                              </div>
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">{inr(needUsd)}</td>
                            <td className="px-4 py-3 text-right tabular-nums">{inrFromAny(Number(a.balance || 0), a.balance_currency)}</td>
                            <td className={cn("px-4 py-3 text-right font-semibold tabular-nums", short ? "text-destructive" : "text-success")}>
                              {short ? `-${inr(Math.abs(diff))} short` : `+${inr(diff)} extra`}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Section 2: Service-wise Pending Totals */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4 text-primary" />
                Service-wise Pending Totals
                <Badge variant="outline" className="text-[10px] gap-1 ml-1">
                  <Radio className="h-3 w-3" /> Live
                </Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Total pending quantity per service category across all providers. Updates live as orders are sent.
              </p>
            </CardHeader>
            <CardContent>
              {breakdown.isLoading ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
                </div>
              ) : serviceCategoryTotals.length === 0 ? (
                <div className="p-6 text-center text-sm text-muted-foreground">No pending services.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {serviceCategoryTotals.map((c) => (
                    <div key={c.category} className="rounded-xl border border-border p-4">
                      <div className="text-xs text-muted-foreground">{c.category}</div>
                      <div className="text-3xl font-bold tabular-nums mt-1 text-primary">{num(c.quantity)}</div>
                      <div className="text-xs text-muted-foreground mt-1">
                        {num(c.runs)} pending runs · {usd(c.userUsd)} user value
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Section 3: Top 5 Users — Pending Order Value */}
          <Card className="glass-card">
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-primary" />
                Top 5 Users — Pending Order Value
                <Badge variant="outline" className="text-[10px] gap-1 ml-1">
                  <Radio className="h-3 w-3" /> Live
                </Badge>
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Users with the highest current pending order value. Watch for fraud: low deposit + high pending value = suspicious.
              </p>
            </CardHeader>
            <CardContent className="p-0">
              {topUsers.isLoading ? (
                <div className="p-4 space-y-2">
                  {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-10" />)}
                </div>
              ) : (topUsers.data || []).length === 0 ? (
                <div className="p-8 text-center text-sm text-muted-foreground">No pending orders.</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-muted-foreground border-b border-border">
                      <tr>
                        <th className="text-left px-4 py-2">#</th>
                        <th className="text-left px-4 py-2">User</th>
                        <th className="text-right px-4 py-2">Pending Orders</th>
                        <th className="text-right px-4 py-2">Pending Value ($)</th>
                        <th className="text-right px-4 py-2">Wallet ($)</th>
                        <th className="text-right px-4 py-2">Deposited ($)</th>
                        <th className="text-right px-4 py-2">Spent ($)</th>
                        <th className="text-center px-4 py-2">Risk</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(topUsers.data || []).map((u, i) => {
                        const risky = u.value > 5 && u.deposited < u.value * 0.5;
                        return (
                          <tr key={u.user_id} className="border-b border-border/40 hover:bg-muted/30">
                            <td className="px-4 py-3 text-muted-foreground">{i + 1}</td>
                            <td className="px-4 py-3">
                              <div className="font-medium">{u.email}</div>
                              {u.name && <div className="text-[11px] text-muted-foreground">{u.name}</div>}
                            </td>
                            <td className="px-4 py-3 text-right tabular-nums">{num(u.count)}</td>
                            <td className="px-4 py-3 text-right tabular-nums font-semibold text-primary">{usd(u.value)}</td>
                            <td className="px-4 py-3 text-right tabular-nums">{usd(u.wallet)}</td>
                            <td className="px-4 py-3 text-right tabular-nums">{usd(u.deposited)}</td>
                            <td className="px-4 py-3 text-right tabular-nums">{usd(u.spent)}</td>
                            <td className="px-4 py-3 text-center">
                              <Badge variant="outline" className={cn("text-[10px]", risky ? "bg-destructive/10 text-destructive border-destructive/30" : "bg-success/10 text-success border-success/30")}>
                                {risky ? "RISK" : "OK"}
                              </Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </TooltipProvider>
    </DashboardLayout>
  );
}
