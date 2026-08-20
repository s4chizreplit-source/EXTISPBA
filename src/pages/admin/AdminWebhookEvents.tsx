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
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { RefreshCw, Webhook, Search, Copy } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';

type EventRow = {
  id: string;
  provider: string | null;
  order_id: string | null;
  track_id: string | null;
  payload_hash: string | null;
  event_status: string | null;
  outcome: string | null;
  http_status: number | null;
  message: string | null;
  payload: any;
  first_seen_at: string | null;
  processed_at: string | null;
  created_at: string;
};

const OUTCOME_VARIANT: Record<string, 'default' | 'destructive' | 'secondary' | 'outline'> = {
  credited: 'default',
  activated: 'default',
  duplicate: 'secondary',
  rejected: 'destructive',
  failed: 'destructive',
  ignored: 'outline',
  received: 'outline',
};

function outcomeBadge(o: string | null) {
  const v = (o && OUTCOME_VARIANT[o.toLowerCase()]) || 'outline';
  return <Badge variant={v}>{o || 'unknown'}</Badge>;
}

function short(s: string | null | undefined, len = 12) {
  if (!s) return '—';
  return s.length > len ? `${s.slice(0, len)}…` : s;
}

function copy(s: string | null | undefined) {
  if (!s) return;
  navigator.clipboard.writeText(s);
  toast.success('Copied');
}

export default function AdminWebhookEvents() {
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [outcomeFilter, setOutcomeFilter] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<EventRow | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['webhook_events', providerFilter, outcomeFilter, search],
    queryFn: async () => {
      let q = supabase
        .from('webhook_events')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);

      if (providerFilter !== 'all') q = q.eq('provider', providerFilter);
      if (outcomeFilter !== 'all') q = q.eq('outcome', outcomeFilter);
      if (search.trim()) {
        const s = search.trim();
        q = q.or(
          `order_id.ilike.%${s}%,track_id.ilike.%${s}%,payload_hash.ilike.%${s}%,message.ilike.%${s}%`,
        );
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as EventRow[];
    },
    refetchInterval: 15_000,
  });

  const rows = data ?? [];
  const duplicates = rows.filter((r) => (r.outcome || '').toLowerCase() === 'duplicate').length;
  const failed = rows.filter((r) =>
    ['rejected', 'failed'].includes((r.outcome || '').toLowerCase()),
  ).length;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-2">
              <Webhook className="h-7 w-7 text-primary" />
              Webhook Events
            </h1>
            <p className="text-muted-foreground text-sm mt-1">
              Debug failed & duplicate webhook deliveries across providers
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <Card className="glass-card">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Total (recent)</p>
              <p className="text-2xl font-bold">{rows.length}</p>
            </CardContent>
          </Card>
          <Card className="glass-card">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Duplicates</p>
              <p className="text-2xl font-bold text-secondary-foreground">{duplicates}</p>
            </CardContent>
          </Card>
          <Card className="glass-card">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">Failed / Rejected</p>
              <p className="text-2xl font-bold text-destructive">{failed}</p>
            </CardContent>
          </Card>
        </div>

        <Card className="glass-card">
          <CardHeader className="pb-3">
            <div className="flex flex-col md:flex-row gap-3">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search order_id, track_id, payload_hash, message…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9"
                />
              </div>
              <Select value={providerFilter} onValueChange={setProviderFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="Provider" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All providers</SelectItem>
                  <SelectItem value="oxapay">OxaPay</SelectItem>
                  <SelectItem value="zapupi">ZapUPI</SelectItem>
                  <SelectItem value="razorpay">Razorpay</SelectItem>
                </SelectContent>
              </Select>
              <Select value={outcomeFilter} onValueChange={setOutcomeFilter}>
                <SelectTrigger className="w-full md:w-40">
                  <SelectValue placeholder="Outcome" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All outcomes</SelectItem>
                  <SelectItem value="credited">Credited</SelectItem>
                  <SelectItem value="activated">Activated</SelectItem>
                  <SelectItem value="duplicate">Duplicate</SelectItem>
                  <SelectItem value="rejected">Rejected</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                  <SelectItem value="ignored">Ignored</SelectItem>
                  <SelectItem value="received">Received</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Time</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Track</TableHead>
                    <TableHead>Hash</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>HTTP</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {isLoading && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        Loading…
                      </TableCell>
                    </TableRow>
                  )}
                  {!isLoading && rows.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        No webhook events match these filters.
                      </TableCell>
                    </TableRow>
                  )}
                  {rows.map((r) => (
                    <TableRow
                      key={r.id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => setSelected(r)}
                    >
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{r.provider || '—'}</Badge>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{short(r.order_id, 16)}</TableCell>
                      <TableCell className="font-mono text-xs">{short(r.track_id, 14)}</TableCell>
                      <TableCell className="font-mono text-xs">{short(r.payload_hash, 10)}</TableCell>
                      <TableCell className="text-xs">{r.event_status || '—'}</TableCell>
                      <TableCell>{outcomeBadge(r.outcome)}</TableCell>
                      <TableCell className="text-xs">{r.http_status ?? '—'}</TableCell>
                      <TableCell className="text-xs max-w-[220px] truncate" title={r.message ?? ''}>
                        {r.message || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Webhook event details</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Provider" value={selected.provider} />
                <Field label="Outcome" value={selected.outcome} />
                <Field label="Event status" value={selected.event_status} />
                <Field label="HTTP status" value={selected.http_status?.toString() ?? null} />
                <Field label="First seen" value={selected.first_seen_at} />
                <Field label="Processed at" value={selected.processed_at} />
              </div>
              <CopyableField label="Order ID" value={selected.order_id} />
              <CopyableField label="Track ID" value={selected.track_id} />
              <CopyableField label="Payload hash" value={selected.payload_hash} />
              {selected.message && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Message</p>
                  <p className="text-sm bg-muted/40 rounded p-2">{selected.message}</p>
                </div>
              )}
              {selected.payload && (
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Payload</p>
                  <pre className="text-xs bg-muted/40 rounded p-2 overflow-x-auto max-h-64">
                    {JSON.stringify(selected.payload, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </DashboardLayout>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium break-all">{value || '—'}</p>
    </div>
  );
}

function CopyableField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <div className="flex items-center gap-2 bg-muted/40 rounded p-2">
        <code className="text-xs flex-1 break-all">{value || '—'}</code>
        {value && (
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => copy(value)}>
            <Copy className="h-3 w-3" />
          </Button>
        )}
      </div>
    </div>
  );
}
