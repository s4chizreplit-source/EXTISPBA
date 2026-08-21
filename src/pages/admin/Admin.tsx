import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { QueueHealthWidget } from '@/components/admin/QueueHealthWidget';
import { CronStatusPanel } from '@/components/admin/CronStatusPanel';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Users,
  ShoppingCart,
  DollarSign,
  Package,
  TrendingUp,
  Activity,
  Zap,
  AlertTriangle,
  ArrowUpRight,
  Sparkles,
  LayoutDashboard,
  Clock,
  CreditCard,
  MessageCircle,
  Globe,
  Percent,
  Save,
  Loader2,
  TrendingDown,
  ShieldAlert,
  Webhook,
} from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { toast } from 'sonner';

export default function Admin() {
  const { isAdmin } = useAuth();
  const queryClient = useQueryClient();
  const [markupInput, setMarkupInput] = useState<string>('');
  const [markupLoaded, setMarkupLoaded] = useState(false);
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [maintenanceLoaded, setMaintenanceLoaded] = useState(false);

  // Optimized Dashboard Stats fetch
  const { data: dashboardStats, isLoading: statsLoading } = useQuery({
    queryKey: ['admin-dashboard-stats'],
    queryFn: async () => {
      const res = await fetch('/api/admin/stats', { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load stats');
      return res.json();
    },
    refetchInterval: 15000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (dashboardStats && !markupLoaded) {
      setMarkupInput(String(dashboardStats.markup ?? 0));
      setMarkupLoaded(true);
    }
    if (dashboardStats && !maintenanceLoaded) {
      setMaintenanceMode(Boolean(dashboardStats.maintenance_mode));
      setMaintenanceLoaded(true);
    }
  }, [dashboardStats, markupLoaded, maintenanceLoaded]);

  // Save markup mutation
  const saveMarkupMutation = useMutation({
    mutationFn: async (percent: number) => {
      const res = await fetch('/api/admin/platform-settings', {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ global_markup_percent: percent }),
      });
      if (!res.ok) throw new Error('Failed to update markup');
    },
    onSuccess: () => {
      toast.success('Global markup updated successfully!');
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] });
      queryClient.invalidateQueries({ queryKey: ['platform-settings-markup'] });
      queryClient.invalidateQueries({ queryKey: ['services'] });
      // Clear localStorage services cache so markup reflects immediately
      localStorage.removeItem('whopautopilot_services_cache');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Maintenance mode toggle mutation
  const toggleMaintenanceMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await fetch('/api/admin/platform-settings', {
        method: 'PATCH', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ maintenance_mode: enabled }),
      });
      if (!res.ok) throw new Error('Failed to update maintenance mode');
    },
    onSuccess: (_, enabled) => {
      toast.success(enabled ? 'Maintenance mode enabled' : 'Maintenance mode disabled');
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // INSTANT RENDER - No blocking loader, redirect in useEffect if needed

  const totalRevenue = dashboardStats?.total_revenue || 0;
  const totalOrders = dashboardStats?.total_orders || 0;
  const userCount = dashboardStats?.user_count || 0;
  const serviceCount = dashboardStats?.service_count || 0;
  const totalDepositsUsd = Number(dashboardStats?.total_deposits || 0);
  const totalWalletUsd = Number(dashboardStats?.total_wallet_balance || 0);
  const depositsTodayUsd = Number(dashboardStats?.deposits_today || 0);
  const depositsCount = Number(dashboardStats?.deposits_count || 0);
  const totalDepositsInr = dashboardStats?.total_deposits_inr != null
    ? Number(dashboardStats.total_deposits_inr)
    : totalDepositsUsd * 83.5;
  const depositsTodayInr = dashboardStats?.deposits_today_inr != null
    ? Number(dashboardStats.deposits_today_inr)
    : depositsTodayUsd * 83.5;

  return (
    <DashboardLayout>
      <div className="space-y-6 min-w-0 px-0 sm:px-4 lg:px-6 pb-8">
        {/* Hero Header */}
        <div className="relative overflow-hidden glass-card p-6 sm:p-8 bg-gradient-to-br from-primary/10 via-transparent to-accent/10">
          <div className="relative z-10 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
             <div className="flex items-center gap-3 sm:gap-4 min-w-0">
              <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-primary/60 flex items-center justify-center shadow-xl shadow-primary/20">
                <LayoutDashboard className="h-7 w-7 text-primary-foreground" />
              </div>
               <div className="min-w-0">
                <h1 className="text-2xl sm:text-3xl font-bold text-foreground">
                  Admin Control Center
                </h1>
                <p className="text-sm text-muted-foreground flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  Complete platform management
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="bg-success/10 text-success border-success/30 gap-1">
                <Activity className="h-3 w-3" />
                System Online
              </Badge>
            </div>
          </div>
          <div className="absolute top-0 right-0 w-60 h-60 bg-gradient-to-bl from-primary/20 to-transparent rounded-full blur-3xl" />
          <div className="absolute bottom-0 left-0 w-40 h-40 bg-gradient-to-tr from-accent/20 to-transparent rounded-full blur-3xl" />
        </div>

        {/* Total User Deposits — Hero Stat */}
        <Card className="glass-card relative overflow-hidden border-2 border-success/30">
          <div className="absolute inset-0 bg-gradient-to-br from-success/10 via-transparent to-success/5" />
          <CardContent className="p-5 sm:p-6 relative">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3 sm:gap-4 min-w-0">
                <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-success to-success/60 flex items-center justify-center shadow-xl shadow-success/20 shrink-0">
                  <CreditCard className="h-7 w-7 text-white" />
                </div>
                <div className="min-w-0">
                   <p className="text-sm font-medium text-muted-foreground">Total Funds Added by Users (All Time)</p>
                  <p className="text-3xl sm:text-4xl font-extrabold text-success">
                    ₹{totalDepositsInr.toFixed(2)}
                  </p>
                  <p className="text-[11px] text-muted-foreground mt-1">
                     All user wallets combined · {depositsCount} successful fund additions · auto-refresh every 15s
                  </p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:gap-3 w-full sm:min-w-[220px] sm:w-auto">
                <div className="p-3 rounded-xl bg-success/5 border border-success/20">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Today</p>
                  <p className="text-lg font-bold text-success">₹{depositsTodayInr.toFixed(2)}</p>
                </div>
                <div className="p-3 rounded-xl bg-primary/5 border border-primary/20">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Live Balance</p>
                  <p className="text-lg font-bold text-primary">₹{(totalWalletUsd * 83.5).toFixed(2)}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Global markup hata diya gaya hai — admin har service ka per-1000 price direct /admin/services se set karta hai */}


        {/* Maintenance Mode Toggle */}
        <Card className={`glass-card border-2 relative overflow-hidden transition-all ${maintenanceMode ? 'border-destructive/50 bg-destructive/5' : 'border-border'}`}>
          <CardContent className="p-5 sm:p-6">
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
              <div className="flex items-center gap-3 sm:gap-4 flex-1 min-w-0">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-xl shrink-0 transition-colors ${maintenanceMode ? 'bg-gradient-to-br from-destructive to-destructive/60 shadow-destructive/20' : 'bg-gradient-to-br from-muted to-muted/60 shadow-muted/20'}`}>
                  <AlertTriangle className={`h-7 w-7 ${maintenanceMode ? 'text-destructive-foreground' : 'text-muted-foreground'}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-lg font-bold text-foreground">Maintenance Mode</h3>
                  <p className="text-sm text-muted-foreground">
                    {maintenanceMode
                      ? 'Site is currently in maintenance — users see a waiting page'
                      : 'Turn on to show a maintenance page to all users while you update'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-3 self-end sm:self-auto shrink-0">
                <span className={`text-sm font-medium ${maintenanceMode ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {maintenanceMode ? 'ON' : 'OFF'}
                </span>
                <Switch
                  checked={maintenanceMode}
                  onCheckedChange={(checked) => {
                    setMaintenanceMode(checked);
                    toggleMaintenanceMutation.mutate(checked);
                  }}
                  disabled={toggleMaintenanceMutation.isPending}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Queue Health Widget */}
        <QueueHealthWidget />

        {/* Cron Status (execute-all-runs + overdue engagement runs) */}
        <CronStatusPanel />

        {/* Quick Access Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 min-w-0">

          <Link to="/admin/bundles" className="block min-w-0">
            <Card className="glass-card h-full hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 transition-all cursor-pointer group border-2 border-primary/20">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/30 to-primary/20 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <Sparkles className="h-6 w-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold group-hover:text-primary transition-colors break-words">
                        Bundles
                      </h3>
                      <Badge className="text-[10px] h-4 px-1.5 bg-primary shrink-0 whitespace-nowrap">NEW</Badge>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Engagement combos</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>


          <Link to="/admin/users" className="block min-w-0">
            <Card className="glass-card h-full hover:border-accent/50 hover:shadow-lg hover:shadow-accent/10 transition-all cursor-pointer group">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent/20 to-accent/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <Users className="h-6 w-6 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold group-hover:text-accent transition-colors break-words">
                      Users
                    </h3>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Manage accounts</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-accent transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to="/admin/cron-monitor" className="block min-w-0">
            <Card className="glass-card h-full hover:border-warning/50 hover:shadow-lg hover:shadow-warning/10 transition-all cursor-pointer group">
              <CardContent className="p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-warning/20 to-warning/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <Clock className="h-6 w-6 text-warning" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold group-hover:text-warning transition-colors break-words">
                        Cron Monitor
                      </h3>
                      <Badge className="text-[10px] h-4 px-1.5 bg-warning text-warning-foreground shrink-0 whitespace-nowrap">LIVE</Badge>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Real-time status</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-warning transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to="/admin/topup-plan" className="block min-w-0">
            <Card className="glass-card h-full hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 transition-all cursor-pointer group">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <TrendingUp className="h-6 w-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold group-hover:text-primary transition-colors break-words">
                        Top-Up Plan
                      </h3>
                      <Badge className="text-[10px] h-4 px-1.5 bg-primary text-primary-foreground shrink-0 whitespace-nowrap">NEW</Badge>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Provider balance vs pending</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to="/admin/oxapay-log" className="block min-w-0">
            <Card className="glass-card h-full hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 transition-all cursor-pointer group">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <Activity className="h-6 w-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold group-hover:text-primary transition-colors break-words">
                        OxaPay Log
                      </h3>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Crypto webhook &amp; poller events</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to="/admin/security-audit" className="block min-w-0">
            <Card className="glass-card h-full hover:border-destructive/50 hover:shadow-lg hover:shadow-destructive/10 transition-all cursor-pointer group">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-destructive/20 to-destructive/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <ShieldAlert className="h-6 w-6 text-destructive" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold group-hover:text-destructive transition-colors break-words">
                        Security Audit
                      </h3>
                      <Badge className="text-[10px] h-4 px-1.5 bg-destructive text-destructive-foreground shrink-0 whitespace-nowrap">NEW</Badge>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Blocked bypass attempts &amp; forgeries</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-destructive transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to="/admin/webhook-events" className="block min-w-0">
            <Card className="glass-card h-full hover:border-primary/50 hover:shadow-lg hover:shadow-primary/10 transition-all cursor-pointer group">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <Webhook className="h-6 w-6 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold group-hover:text-primary transition-colors break-words">
                        Webhook Events
                      </h3>
                      <Badge className="text-[10px] h-4 px-1.5 bg-primary text-primary-foreground shrink-0 whitespace-nowrap">NEW</Badge>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Debug failed &amp; duplicate deliveries</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>


          <Link to="/admin/chat" className="block min-w-0">
            <Card className="glass-card h-full hover:border-success/50 hover:shadow-lg hover:shadow-success/10 transition-all cursor-pointer group border-2 border-success/30">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-success/30 to-success/20 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <MessageCircle className="h-6 w-6 text-success" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold group-hover:text-success transition-colors break-words">
                        Live Chat
                      </h3>
                      <Badge className="text-[10px] h-4 px-1.5 bg-success text-success-foreground shrink-0 whitespace-nowrap">LIVE</Badge>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">Support messages</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-success transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>

          <Link to="/admin/provider-accounts" className="block min-w-0">
            <Card className="glass-card h-full hover:border-accent/50 hover:shadow-lg hover:shadow-accent/10 transition-all cursor-pointer group border-2 border-accent/30">
              <CardContent className="p-4 sm:p-5">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent/30 to-accent/20 flex items-center justify-center group-hover:scale-110 transition-transform shrink-0">
                    <Globe className="h-6 w-6 text-accent" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="font-semibold group-hover:text-accent transition-colors break-words">
                        Provider Accounts
                      </h3>
                      <Badge className="text-[10px] h-4 px-1.5 bg-accent text-accent-foreground shrink-0 whitespace-nowrap">NEW</Badge>
                    </div>
                    <p className="text-xs leading-snug text-muted-foreground break-words">API keys &amp; URLs</p>
                  </div>
                  <ArrowUpRight className="h-4 w-4 shrink-0 self-start text-muted-foreground group-hover:text-accent transition-colors" />
                </div>
              </CardContent>
            </Card>
          </Link>


        </div>
      </div>
    </DashboardLayout>
  );
}
