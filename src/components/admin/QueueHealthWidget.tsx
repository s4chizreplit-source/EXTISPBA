import { useQuery } from '@tanstack/react-query';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Server,
  XCircle,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';

interface QueueStats {
  overduePending: number;
  activeStarted: number;
  completedLast1h: number;
  failedLast1h: number;
  totalPending: number;
  avgCompletionMin: number;
  providerStats: { name: string; started: number; completed: number; failed: number }[];
}

export function QueueHealthWidget() {
  const { data: stats, isLoading, refetch, isFetching } = useQuery<QueueStats>({
    queryKey: ['queue-health'],
    queryFn: async () => {
      const res = await fetch('/api/admin/queue-health', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load queue health');
      const body = await res.json();

      return {
        overduePending: body.overduePending ?? 0,
        activeStarted: body.activeStarted ?? 0,
        completedLast1h: body.completedLast1h ?? 0,
        failedLast1h: body.failedLast1h ?? 0,
        totalPending: body.totalPending ?? 0,
        avgCompletionMin: body.avgCompletionMin ?? 0,
        providerStats: (body.providerStats ?? []).sort(
          (a: QueueStats['providerStats'][number], b: QueueStats['providerStats'][number]) =>
            (b.completed + b.started) - (a.completed + a.started),
        ),
      };
    },
    refetchInterval: 30000,
  });

  if (isLoading) {
    return (
      <Card className="glass-card">
        <CardContent className="p-6 flex items-center justify-center gap-2 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          Loading queue health...
        </CardContent>
      </Card>
    );
  }

  if (!stats) return null;

  const healthScore =
    stats.overduePending === 0 && stats.failedLast1h === 0
      ? 'healthy'
      : stats.overduePending > 20 || stats.failedLast1h > 10
        ? 'critical'
        : 'warning';

  const healthColor = {
    healthy: 'text-success',
    warning: 'text-warning',
    critical: 'text-destructive',
  }[healthScore];

  const healthBg = {
    healthy: 'from-success/10 to-success/5',
    warning: 'from-warning/10 to-warning/5',
    critical: 'from-destructive/10 to-destructive/5',
  }[healthScore];

  return (
    <Card className={`glass-card border-2 relative overflow-hidden ${healthScore === 'critical' ? 'border-destructive/40' : healthScore === 'warning' ? 'border-warning/40' : 'border-success/30'}`}>
      <div className={`absolute inset-0 bg-gradient-to-r ${healthBg}`} />
      <CardContent className="p-5 sm:p-6 relative space-y-5">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br ${healthScore === 'critical' ? 'from-destructive to-destructive/60' : healthScore === 'warning' ? 'from-warning to-warning/60' : 'from-success to-success/60'} flex items-center justify-center shadow-lg`}>
              <Activity className="h-6 w-6 text-primary-foreground" />
            </div>
            <div>
              <h3 className="text-lg font-bold text-foreground">Queue Health</h3>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <span className={`inline-block w-2 h-2 rounded-full ${healthScore === 'critical' ? 'bg-destructive' : healthScore === 'warning' ? 'bg-warning' : 'bg-success'} animate-pulse`} />
                {healthScore === 'healthy' ? 'All systems operational' : healthScore === 'warning' ? 'Minor delays detected' : 'Attention required'}
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <div className="bg-background/50 rounded-xl p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <AlertTriangle className="h-4 w-4 text-warning" />
            </div>
            <p className={`text-2xl font-bold ${stats.overduePending > 0 ? 'text-warning' : 'text-foreground'}`}>
              {stats.overduePending}
            </p>
            <p className="text-[11px] text-muted-foreground">Overdue</p>
          </div>

          <div className="bg-background/50 rounded-xl p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <RefreshCw className="h-4 w-4 text-primary animate-spin" />
            </div>
            <p className="text-2xl font-bold text-primary">{stats.activeStarted}</p>
            <p className="text-[11px] text-muted-foreground">In Progress</p>
          </div>

          <div className="bg-background/50 rounded-xl p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <CheckCircle2 className="h-4 w-4 text-success" />
            </div>
            <p className="text-2xl font-bold text-success">{stats.completedLast1h}</p>
            <p className="text-[11px] text-muted-foreground">Done (1h)</p>
          </div>

          <div className="bg-background/50 rounded-xl p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <XCircle className="h-4 w-4 text-destructive" />
            </div>
            <p className={`text-2xl font-bold ${stats.failedLast1h > 0 ? 'text-destructive' : 'text-foreground'}`}>
              {stats.failedLast1h}
            </p>
            <p className="text-[11px] text-muted-foreground">Failed (1h)</p>
          </div>

          <div className="bg-background/50 rounded-xl p-3 text-center">
            <div className="flex items-center justify-center gap-1 mb-1">
              <Clock className="h-4 w-4 text-muted-foreground" />
            </div>
            <p className="text-2xl font-bold">{stats.avgCompletionMin || '—'}</p>
            <p className="text-[11px] text-muted-foreground">Avg min</p>
          </div>
        </div>

        {/* Pending queue */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Clock className="h-4 w-4" />
          <span>Total pending queue: <strong className="text-foreground">{stats.totalPending}</strong> runs</span>
        </div>

        {/* Provider Rotation Stats */}
        {stats.providerStats.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-2">
              <Server className="h-4 w-4" />
              Provider Rotation (24h)
            </h4>
            <div className="space-y-2">
              {stats.providerStats.map((provider) => {
                const total = provider.started + provider.completed + provider.failed;
                const successRate = total > 0 ? Math.round((provider.completed / total) * 100) : 0;
                return (
                  <div key={provider.name} className="bg-background/50 rounded-lg p-3 flex items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm truncate">{provider.name}</span>
                        <Badge variant="outline" className={`text-[10px] h-4 px-1.5 ${successRate >= 80 ? 'border-success/50 text-success' : successRate >= 50 ? 'border-warning/50 text-warning' : 'border-destructive/50 text-destructive'}`}>
                          {successRate}%
                        </Badge>
                      </div>
                      {/* Progress bar */}
                      <div className="flex h-1.5 rounded-full overflow-hidden mt-1.5 bg-muted">
                        {provider.completed > 0 && (
                          <div
                            className="bg-success h-full"
                            style={{ width: `${(provider.completed / total) * 100}%` }}
                          />
                        )}
                        {provider.started > 0 && (
                          <div
                            className="bg-primary h-full"
                            style={{ width: `${(provider.started / total) * 100}%` }}
                          />
                        )}
                        {provider.failed > 0 && (
                          <div
                            className="bg-destructive h-full"
                            style={{ width: `${(provider.failed / total) * 100}%` }}
                          />
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground shrink-0">
                      <span className="text-success">{provider.completed}✓</span>
                      <span className="text-primary">{provider.started}⟳</span>
                      <span className="text-destructive">{provider.failed}✗</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
