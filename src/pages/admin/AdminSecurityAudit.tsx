import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { RefreshCw, ShieldAlert, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type AuditRow = {
  id: string;
  created_at: string;
  category: string;
  source: string;
  reason: string;
  provider: string | null;
  order_id: string | null;
  track_id: string | null;
  user_id: string | null;
  http_status: number | null;
  ip: string | null;
  user_agent: string | null;
  request_path: string | null;
  payload: any;
  metadata: any;
};

const CATEGORY_LABEL: Record<string, string> = {
  webhook_forgery: 'Forged webhook',
  webhook_replay: 'Replay attempt',
  webhook_invalid_signature: 'Bad signature',
  webhook_unverified_status: 'Unverified status',
  webhook_missing_field: 'Missing field',
  payment_gate_denied: 'Payment gate denied',
  rpc_denied: 'RPC denied',
  rls_denied: 'RLS denied',
};

const CATEGORY_VARIANT: Record<string, 'destructive' | 'secondary' | 'outline'> = {
  webhook_forgery: 'destructive',
  webhook_invalid_signature: 'destructive',
  webhook_replay: 'secondary',
  webhook_unverified_status: 'secondary',
  webhook_missing_field: 'outline',
  payment_gate_denied: 'outline',
  rpc_denied: 'destructive',
  rls_denied: 'destructive',
};

export default function AdminSecurityAudit() {
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<AuditRow | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['security-audit-log', categoryFilter, providerFilter, search],
    queryFn: async () => {
      let q = supabase
        .from('security_audit_log' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (categoryFilter !== 'all') q = q.eq('category', categoryFilter);
      if (providerFilter !== 'all') q = q.eq('provider', providerFilter);
      if (search.trim()) q = q.or(`order_id.ilike.%${search.trim()}%,user_id.eq.${search.trim()},ip.ilike.%${search.trim()}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as AuditRow[];
    },
    refetchInterval: 20000,
  });

  const rows = data ?? [];
  const critical = rows.filter((r) =>
    ['webhook_forgery', 'webhook_invalid_signature', 'rpc_denied', 'rls_denied'].includes(r.category),
  ).length;

  return (
    <DashboardLayout>
      <div className="space-y-4 p-4 md:p-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <ShieldAlert className="h-6 w-6 text-destructive" />
              Security Audit Log
            </h1>
            <p className="text-sm text-muted-foreground">
              Every blocked bypass attempt — forged webhooks, replayed deliveries,
              denied RPC calls, and payment-gate rejections. Auto-refreshes every 20s.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{rows.length} events</Badge>
            <Badge variant={critical > 0 ? 'destructive' : 'secondary'}>
              {critical} critical
            </Badge>
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </div>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <div className="flex flex-wrap gap-2 items-center">
              <div className="relative flex-1 min-w-[220px]">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search order_id, user_id, or IP…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All categories</SelectItem>
                  {Object.entries(CATEGORY_LABEL).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  <SelectItem value="oxapay">OxaPay</SelectItem>
                  <SelectItem value="zapupi">ZapUPI</SelectItem>
                  <SelectItem value="razorpay">Razorpay</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase">
                  <tr>
                    <th className="p-3">When</th>
                    <th className="p-3">Category</th>
                    <th className="p-3">Source</th>
                    <th className="p-3">Provider</th>
                    <th className="p-3">Order</th>
                    <th className="p-3">User</th>
                    <th className="p-3">IP</th>
                    <th className="p-3">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">Loading…</td></tr>
                  )}
                  {!isLoading && rows.length === 0 && (
                    <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No security events recorded. 🎉</td></tr>
                  )}
                  {rows.map((r) => (
                    <tr
                      key={r.id}
                      className="border-t hover:bg-muted/30 cursor-pointer"
                      onClick={() => setSelected(r)}
                    >
                      <td className="p-3 whitespace-nowrap">
                        {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                      </td>
                      <td className="p-3">
                        <Badge variant={CATEGORY_VARIANT[r.category] ?? 'outline'}>
                          {CATEGORY_LABEL[r.category] ?? r.category}
                        </Badge>
                      </td>
                      <td className="p-3 font-mono text-xs">{r.source}</td>
                      <td className="p-3 text-xs">{r.provider || '—'}</td>
                      <td className="p-3 font-mono text-xs max-w-[160px] truncate">{r.order_id || '—'}</td>
                      <td className="p-3 font-mono text-xs max-w-[160px] truncate">{r.user_id || '—'}</td>
                      <td className="p-3 font-mono text-xs">{r.ip || '—'}</td>
                      <td className="p-3 text-xs max-w-[320px] truncate">{r.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Security event details</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="space-y-3 text-sm max-h-[70vh] overflow-auto">
                <div className="grid grid-cols-2 gap-2">
                  <div><span className="text-muted-foreground">When:</span> {new Date(selected.created_at).toLocaleString()}</div>
                  <div><span className="text-muted-foreground">Category:</span> {CATEGORY_LABEL[selected.category] ?? selected.category}</div>
                  <div><span className="text-muted-foreground">Source:</span> <code>{selected.source}</code></div>
                  <div><span className="text-muted-foreground">Provider:</span> {selected.provider || '—'}</div>
                  <div><span className="text-muted-foreground">HTTP:</span> {selected.http_status ?? '—'}</div>
                  <div><span className="text-muted-foreground">Path:</span> <code>{selected.request_path || '—'}</code></div>
                  <div><span className="text-muted-foreground">Order:</span> <code>{selected.order_id || '—'}</code></div>
                  <div><span className="text-muted-foreground">Track:</span> <code>{selected.track_id || '—'}</code></div>
                  <div><span className="text-muted-foreground">User:</span> <code>{selected.user_id || '—'}</code></div>
                  <div><span className="text-muted-foreground">IP:</span> <code>{selected.ip || '—'}</code></div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs mb-1">Reason</div>
                  <div className="rounded bg-muted p-2 text-xs">{selected.reason}</div>
                </div>
                {selected.user_agent && (
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">User agent</div>
                    <div className="rounded bg-muted p-2 text-xs break-all">{selected.user_agent}</div>
                  </div>
                )}
                {selected.metadata && (
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Metadata</div>
                    <pre className="rounded bg-muted p-2 text-xs overflow-auto max-h-48">
                      {JSON.stringify(selected.metadata, null, 2)}
                    </pre>
                  </div>
                )}
                {selected.payload && (
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Payload</div>
                    <pre className="rounded bg-muted p-2 text-xs overflow-auto max-h-72">
                      {JSON.stringify(selected.payload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
