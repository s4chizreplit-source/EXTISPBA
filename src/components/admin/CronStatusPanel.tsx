import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { Clock, AlertTriangle, CheckCircle2, RefreshCw, Loader2, Timer } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

interface CronStatusData {
  jobs: { id: number; name: string; schedule: string; frequency: string; active: boolean }[];
  recentRuns: { id: number; jobName: string; status: string; startTime: string; endTime: string | null }[];
  stats: { totalRuns: number; successCount: number; failedCount: number; successRate: number };
}

export function CronStatusPanel() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['cron-status-panel'],
    queryFn: async () => {
      const nowIso = new Date().toISOString();

      const [statusRes, overdueRes, lastCompletedRes] = await Promise.all([
        supabase.functions.invoke<CronStatusData>('cron-status'),
        supabase
          .from('organic_run_schedule')
          .select('id, scheduled_at', { count: 'exact' })
          .eq('status', 'pending')
          .not('engagement_order_item_id', 'is', null)
          .lte('scheduled_at', nowIso)
          .order('scheduled_at', { ascending: true })
          .limit(5),
        supabase
          .from('organic_run_schedule')
          .select('completed_at')
          .eq('status', 'completed')
          .not('engagement_order_item_id', 'is', null)
          .order('completed_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      return {
        cron: statusRes.data,
        overdueCount: overdueRes.count ?? 0,
        oldestOverdue: overdueRes.data?.[0]?.scheduled_at ?? null,
        lastCompletedAt: lastCompletedRes.data?.completed_at ?? null,
      };
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card className="glass-card">
        <CardContent className="p-6 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" /> Loading cron status...
        </CardContent>
      </Card>
    );
  }

  const execAllJob = data?.cron?.jobs?.find((j) =>
    j.name.toLowerCase().includes('execute-all-runs'),
  );
  const recentExecRuns = (data?.cron?.recentRuns ?? []).filter(
    (r) => r.jobName === 'execute-all-runs',
  );
  const lastRun = recentExecRuns[0];
  const lastSuccess = recentExecRuns.find((r) => r.status === 'succeeded');

  const overdueCount = data?.overdueCount ?? 0;
  const oldestOverdue = data?.oldestOverdue;

  const healthy = !!execAllJob?.active && overdueCount === 0;
  const borderClass = healthy
    ? 'border-success/30'
    : overdueCount > 10
      ? 'border-destructive/40'
      : 'border-warning/40';

  return (
    <Card className={`glass-card border-2 ${borderClass}`}>
      <CardContent className="p-5 sm:p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg bg-gradient-to-br ${
                healthy ? 'from-success to-success/60' : 'from-warning to-warning/60'
              }`}
            >
              <Timer className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-bold">Cron Status — execute-all-runs</h3>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <span
                  className={`inline-block w-2 h-2 rounded-full animate-pulse ${
                    healthy ? 'bg-success' : 'bg-warning'
                  }`}
                />
                {execAllJob?.active
                  ? `Scheduled: ${execAllJob.frequency}`
                  : 'Cron job not active'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="sm">
              <Link to="/admin/cron-monitor">Full monitor</Link>
            </Button>
            <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-background/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
              <Clock className="h-4 w-4" /> Last run
            </div>
            <p className="text-base font-semibold">
              {lastRun?.startTime
                ? `${formatDistanceToNow(new Date(lastRun.startTime))} ago`
                : '—'}
            </p>
            {lastRun && (
              <Badge
                variant="outline"
                className={`mt-2 text-[10px] ${
                  lastRun.status === 'succeeded'
                    ? 'border-success/50 text-success'
                    : 'border-destructive/50 text-destructive'
                }`}
              >
                {lastRun.status}
              </Badge>
            )}
          </div>

          <div className="bg-background/50 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
              <CheckCircle2 className="h-4 w-4 text-success" /> Last success
            </div>
            <p className="text-base font-semibold">
              {lastSuccess?.startTime
                ? `${formatDistanceToNow(new Date(lastSuccess.startTime))} ago`
                : '—'}
            </p>
            <p className="text-[11px] text-muted-foreground mt-2">
              Last engagement run completed:{' '}
              {data?.lastCompletedAt
                ? `${formatDistanceToNow(new Date(data.lastCompletedAt))} ago`
                : '—'}
            </p>
          </div>

          <div
            className={`rounded-xl p-4 ${
              overdueCount > 0 ? 'bg-warning/10' : 'bg-background/50'
            }`}
          >
            <div className="flex items-center gap-2 mb-1 text-xs text-muted-foreground">
              <AlertTriangle
                className={`h-4 w-4 ${overdueCount > 0 ? 'text-warning' : 'text-muted-foreground'}`}
              />{' '}
              Overdue engagement runs
            </div>
            <p
              className={`text-2xl font-bold ${
                overdueCount > 0 ? 'text-warning' : 'text-foreground'
              }`}
            >
              {overdueCount}
            </p>
            <p className="text-[11px] text-muted-foreground mt-2">
              {oldestOverdue
                ? `Oldest: ${formatDistanceToNow(new Date(oldestOverdue))} ago`
                : 'All on schedule'}
            </p>
          </div>
        </div>

        {data?.cron?.stats && (
          <div className="flex items-center gap-4 text-xs text-muted-foreground border-t border-border/30 pt-3">
            <span>
              Success rate (recent runs):{' '}
              <strong className="text-foreground">{data.cron.stats.successRate}%</strong>
            </span>
            <span>•</span>
            <span>
              {data.cron.stats.successCount}✓ / {data.cron.stats.failedCount}✗ of{' '}
              {data.cron.stats.totalRuns}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
