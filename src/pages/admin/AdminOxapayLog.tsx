import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { RefreshCw, AlertCircle, CheckCircle2, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

type LogRow = {
  id: string;
  created_at: string;
  source: string;
  event: string;
  order_id: string | null;
  user_id: string | null;
  plan_type: string | null;
  purpose: string | null;
  amount_usd: number | null;
  provider_status: string | null;
  http_status: number | null;
  ok: boolean;
  message: string | null;
  payload: any;
};

export default function AdminOxapayLog() {
  const [sourceFilter, setSourceFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<LogRow | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['oxapay-activity-log', sourceFilter, statusFilter, search],
    queryFn: async () => {
      let q = supabase
        .from('oxapay_activity_log' as any)
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);
      if (sourceFilter !== 'all') q = q.eq('source', sourceFilter);
      if (statusFilter === 'ok') q = q.eq('ok', true);
      if (statusFilter === 'error') q = q.eq('ok', false);
      if (search.trim()) q = q.ilike('order_id', `%${search.trim()}%`);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as LogRow[];
    },
    refetchInterval: 15000,
  });

  const rows = data ?? [];
  const errorCount = rows.filter((r) => !r.ok).length;

  return (
    <DashboardLayout>
      <div className="space-y-4 p-4 md:p-6">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold">OxaPay Activity Log</h1>
            <p className="text-sm text-muted-foreground">
              Webhook and poller events for crypto payments. Auto-refreshes every 15s.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="outline">{rows.length} events</Badge>
            <Badge variant={errorCount > 0 ? 'destructive' : 'secondary'}>
              {errorCount} errors
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
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  className="pl-8"
                  placeholder="Search by order_id…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <Select value={sourceFilter} onValueChange={setSourceFilter}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All sources</SelectItem>
                  <SelectItem value="webhook">Webhook</SelectItem>
                  <SelectItem value="poller">Poller</SelectItem>
                </SelectContent>
              </Select>
              <Select value={statusFilter} onValueChange={setStatusFilter}>
                <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="ok">Success only</SelectItem>
                  <SelectItem value="error">Errors only</SelectItem>
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
                    <th className="p-3">Source</th>
                    <th className="p-3">Event</th>
                    <th className="p-3">Order</th>
                    <th className="p-3">Plan / Purpose</th>
                    <th className="p-3">USD</th>
                    <th className="p-3">Provider</th>
                    <th className="p-3">Message</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && (
                    <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">Loading…</td></tr>
                  )}
                  {!isLoading && rows.length === 0 && (
                    <tr><td colSpan={9} className="p-6 text-center text-muted-foreground">No events yet.</td></tr>
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
                      <td className="p-3"><Badge variant="outline">{r.source}</Badge></td>
                      <td className="p-3 font-mono text-xs">{r.event}</td>
                      <td className="p-3 font-mono text-xs">{r.order_id || '—'}</td>
                      <td className="p-3 text-xs">
                        {r.purpose === 'subscription' ? (r.plan_type || 'sub') : (r.purpose || '—')}
                      </td>
                      <td className="p-3">{r.amount_usd ? `$${Number(r.amount_usd).toFixed(2)}` : '—'}</td>
                      <td className="p-3 text-xs">{r.provider_status || '—'}</td>
                      <td className="p-3 text-xs max-w-[280px] truncate">{r.message || '—'}</td>
                      <td className="p-3">
                        {r.ok ? (
                          <Badge variant="secondary" className="gap-1">
                            <CheckCircle2 className="h-3 w-3" /> ok
                          </Badge>
                        ) : (
                          <Badge variant="destructive" className="gap-1">
                            <AlertCircle className="h-3 w-3" /> {r.http_status || 'err'}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Event details</DialogTitle>
            </DialogHeader>
            {selected && (
              <div className="space-y-3 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div><span className="text-muted-foreground">When:</span> {new Date(selected.created_at).toLocaleString()}</div>
                  <div><span className="text-muted-foreground">Source:</span> {selected.source}</div>
                  <div><span className="text-muted-foreground">Event:</span> <code>{selected.event}</code></div>
                  <div><span className="text-muted-foreground">Status:</span> {selected.ok ? 'ok' : `error (${selected.http_status ?? '—'})`}</div>
                  <div><span className="text-muted-foreground">Order:</span> <code>{selected.order_id || '—'}</code></div>
                  <div><span className="text-muted-foreground">User:</span> <code>{selected.user_id || '—'}</code></div>
                  <div><span className="text-muted-foreground">Purpose:</span> {selected.purpose || '—'}</div>
                  <div><span className="text-muted-foreground">Plan:</span> {selected.plan_type || '—'}</div>
                  <div><span className="text-muted-foreground">Amount:</span> {selected.amount_usd ? `$${Number(selected.amount_usd).toFixed(2)}` : '—'}</div>
                  <div><span className="text-muted-foreground">Provider:</span> {selected.provider_status || '—'}</div>
                </div>
                {selected.message && (
                  <div>
                    <div className="text-muted-foreground text-xs mb-1">Message</div>
                    <div className="rounded bg-muted p-2 text-xs">{selected.message}</div>
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
