import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import {
  Users,
  Search,
  Loader2,
  ArrowLeft,
  Wallet,
  Shield,
  Plus,
  Minus,
  Mail,
  Calendar,
  DollarSign,
  Crown,
  Zap,
  XCircle,
  UserX,
  Clock,
  Pause,
  Play,
  ShoppingCart,
  Ban,
  AlertTriangle,
} from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import { toast } from 'sonner';
import { format, formatDistanceToNow } from 'date-fns';

interface OrderCounts {
  singleActive: number;
  singlePaused: number;
  engagementActive: number;
  engagementPaused: number;
}

interface UserProfile {
  id: string;
  user_id: string;
  email: string;
  full_name: string | null;
  currency: string;
  created_at: string;
  wallet?: {
    balance: number;
    total_deposited: number;
    total_spent: number;
  };
  role?: string;
  orderCounts?: OrderCounts;
}


export default function AdminUsers() {
  const { user, isAdmin, isLoading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [balanceAmount, setBalanceAmount] = useState('');
  const [balanceAction, setBalanceAction] = useState<'add' | 'subtract'>('add');
  const [pauseUser, setPauseUser] = useState<UserProfile | null>(null);
  const [selfTestRunning, setSelfTestRunning] = useState(false);
  const [selfTestSteps, setSelfTestSteps] = useState<Array<{ label: string; ok: boolean | null; detail?: string }>>([]);
  const [cancelUser, setCancelUser] = useState<UserProfile | null>(null);
  const [refundOnCancel, setRefundOnCancel] = useState(false);

  const { data: users, isLoading } = useQuery({
    queryKey: ['admin-all-users-with-subs'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_admin_users_summary' as any);
      if (error) throw error;

      // A partially imported backend can still return more than one row per
      // auth user. Collapse by user id (email as fallback) and keep the row
      // that carries the most data so admin/wallet info never splits.
      const byUser = new Map<string, any>();
      for (const u of ((data as any) || [])) {
        const key = String(u.user_id || u.id || u.email || '').toLowerCase();
        if (!key) continue;
        const prev = byUser.get(key);
        const weight = (r: any) =>
          (Number(r?.balance) || 0) + (Number(r?.total_deposited) || 0) + (Number(r?.total_spent) || 0) +
          (r?.subscription_plan && r.subscription_plan !== 'none' ? 1 : 0) +
          (r?.is_admin || r?.role === 'admin' ? 1 : 0);
        if (!prev || weight(u) > weight(prev)) byUser.set(key, prev ? { ...prev, ...u } : u);
        else byUser.set(key, { ...u, ...prev });
      }

      return Array.from(byUser.values()).map((u: any) => ({
        ...u,
        wallet: {
          balance: u.balance,
          total_deposited: u.total_deposited,
          total_spent: u.total_spent
        },
        orderCounts: {
          singleActive: u.active_single_orders,
          singlePaused: u.paused_single_orders,
          engagementActive: u.active_engagement_orders,
          engagementPaused: u.paused_engagement_orders,
        }
      })) as UserProfile[];

    },
  });

  // The users RPC may return the auth id under different keys depending on
  // backend version — resolve it defensively so admin actions never send "null".
  const resolveUserId = (u: UserProfile | null): string => {
    const id = (u as any)?.user_id || (u as any)?.id || (u as any)?.uid;
    if (!id || typeof id !== 'string') throw new Error('User ID missing — reload the page and try again');
    return id;
  };

  const updateBalanceMutation = useMutation({
    mutationFn: async () => {
      if (!selectedUser || !balanceAmount) return;
      const targetUserId = resolveUserId(selectedUser);

      const INR_RATE = 83.5; // Same rate used by Razorpay credit flow
      const inrAmount = parseFloat(balanceAmount);
      if (!inrAmount || inrAmount <= 0) throw new Error('Enter a valid INR amount');
      // Convert INR → USD because wallets are stored in USD internally
      const amount = Math.trunc((inrAmount / INR_RATE) * 10000) / 10000;

      // Read live balance instead of trusting the cached list row.
      const { data: liveWallet } = await supabase
        .from('wallets')
        .select('balance, total_deposited')
        .eq('user_id', targetUserId)
        .maybeSingle();

      const currentBalance = Number(liveWallet?.balance ?? selectedUser.wallet?.balance ?? 0);
      const currentDeposited = Number(liveWallet?.total_deposited ?? selectedUser.wallet?.total_deposited ?? 0);
      const newBalance =
        Math.trunc((balanceAction === 'add' ? currentBalance + amount : currentBalance - amount) * 10000) / 10000;

      if (newBalance < 0) throw new Error('Balance cannot be negative');

      // Upsert so a missing wallet row is created instead of silently doing nothing.
      const { error: walletError } = await supabase
        .from('wallets')
        .upsert({
          user_id: targetUserId,
          balance: newBalance,
          total_deposited: balanceAction === 'add' ? currentDeposited + amount : currentDeposited,
        }, { onConflict: 'user_id' });

      if (walletError) throw walletError;

      const { error: txError } = await supabase.from('transactions').insert({
        user_id: targetUserId,
        type: balanceAction === 'add' ? 'deposit' : 'withdrawal',
        amount: balanceAction === 'add' ? amount : -amount,
        balance_after: newBalance,
        description: `Admin ${balanceAction === 'add' ? 'deposit' : 'withdrawal'} — ₹${inrAmount.toFixed(2)}`,
        status: 'completed',
      });

      if (txError) throw txError;
    },
    onSuccess: () => {
      toast.success('Balance updated successfully!');
      setSelectedUser(null);
      setBalanceAmount('');
      queryClient.invalidateQueries({ queryKey: ['admin-all-users-with-subs'] });
      queryClient.invalidateQueries({ queryKey: ['admin-dashboard-stats'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const toggleAdminMutation = useMutation({
    mutationFn: async (targetUser: UserProfile) => {
      const newRole = targetUser.role === 'admin' ? 'user' : 'admin';
      const { error } = await supabase
        .from('user_roles')
        .update({ role: newRole })
        .eq('user_id', targetUser.user_id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('User role updated!');
      queryClient.invalidateQueries({ queryKey: ['admin-all-users-with-subs'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  // Pause all orders mutation
  const pauseAllOrdersMutation = useMutation({
    mutationFn: async (targetUser: UserProfile) => {
      // 1. Update single orders to paused
      const { error: singleError } = await supabase
        .from('orders')
        .update({ status: 'paused' })
        .eq('user_id', targetUser.user_id)
        .in('status', ['pending', 'processing']);

      if (singleError) throw singleError;

      // 2. Update engagement orders to paused
      const { error: engagementError } = await supabase
        .from('engagement_orders')
        .update({ status: 'paused' })
        .eq('user_id', targetUser.user_id)
        .in('status', ['pending', 'processing']);

      if (engagementError) throw engagementError;
    },
    onSuccess: () => {
      toast.success('All orders paused!');
      setPauseUser(null);
      queryClient.invalidateQueries({ queryKey: ['admin-all-users-with-subs'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  // Resume all orders mutation
  const resumeAllOrdersMutation = useMutation({
    mutationFn: async (targetUser: UserProfile) => {
      const now = new Date().toISOString();

      // 1. Get all paused engagement orders for this user
      const { data: pausedEngOrders } = await supabase
        .from('engagement_orders')
        .select('id')
        .eq('user_id', targetUser.user_id)
        .eq('status', 'paused');

      // 2. Get all paused single orders for this user
      const { data: pausedSingleOrders } = await supabase
        .from('orders')
        .select('id')
        .eq('user_id', targetUser.user_id)
        .eq('status', 'paused');

      // 3. Cancel overdue pending runs for engagement orders (scheduled during pause)
      if (pausedEngOrders && pausedEngOrders.length > 0) {
        // Get engagement order item IDs
        const { data: items } = await supabase
          .from('engagement_order_items')
          .select('id')
          .in('engagement_order_id', pausedEngOrders.map(o => o.id));

        if (items && items.length > 0) {
          const { error: cancelError } = await supabase
            .from('organic_run_schedule')
            .update({
              status: 'cancelled',
              error_message: 'Skipped — order was paused during this scheduled time',
              completed_at: now,
            })
            .in('engagement_order_item_id', items.map(i => i.id))
            .eq('status', 'pending')
            .lt('scheduled_at', now);

          if (cancelError) console.error('Cancel overdue engagement runs error:', cancelError);
        }
      }

      // 4. Cancel overdue pending runs for single orders (scheduled during pause)
      if (pausedSingleOrders && pausedSingleOrders.length > 0) {
        const { error: cancelSingleError } = await supabase
          .from('organic_run_schedule')
          .update({
            status: 'cancelled',
            error_message: 'Skipped — order was paused during this scheduled time',
            completed_at: now,
          })
          .in('order_id', pausedSingleOrders.map(o => o.id))
          .eq('status', 'pending')
          .lt('scheduled_at', now);

        if (cancelSingleError) console.error('Cancel overdue single runs error:', cancelSingleError);
      }

      // 5. Resume single orders
      const { error: singleError } = await supabase
        .from('orders')
        .update({ status: 'processing' })
        .eq('user_id', targetUser.user_id)
        .eq('status', 'paused');

      if (singleError) throw singleError;

      // 6. Resume engagement orders
      const { error: engagementError } = await supabase
        .from('engagement_orders')
        .update({ status: 'processing' })
        .eq('user_id', targetUser.user_id)
        .eq('status', 'paused');

      if (engagementError) throw engagementError;
    },
    onSuccess: () => {
      toast.success('All orders resumed! Overdue runs during pause were cancelled.');
      queryClient.invalidateQueries({ queryKey: ['admin-all-users-with-subs'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  // Cancel all orders mutation
  const cancelAllOrdersMutation = useMutation({
    mutationFn: async ({ targetUser, refund }: { targetUser: UserProfile; refund: boolean }) => {
      // 1. Get all single orders for this user
      const { data: singleOrders } = await supabase
        .from('orders')
        .select('id, price')
        .eq('user_id', targetUser.user_id)
        .not('status', 'in', '("completed","cancelled","failed")');

      // 2. Get all engagement orders for this user
      const { data: engagementOrders } = await supabase
        .from('engagement_orders')
        .select('id, total_price')
        .eq('user_id', targetUser.user_id)
        .not('status', 'in', '("completed","cancelled","failed")');

      // 3. Cancel all pending runs for single orders
      for (const order of singleOrders || []) {
        await supabase
          .from('organic_run_schedule')
          .update({ status: 'cancelled' })
          .eq('order_id', order.id)
          .eq('status', 'pending');
      }

      // 4. Get engagement order items and cancel their runs
      for (const eo of engagementOrders || []) {
        const { data: items } = await supabase
          .from('engagement_order_items')
          .select('id')
          .eq('engagement_order_id', eo.id);

        for (const item of items || []) {
          await supabase
            .from('organic_run_schedule')
            .update({ status: 'cancelled' })
            .eq('engagement_order_item_id', item.id)
            .eq('status', 'pending');
        }

        // Cancel the items too
        await supabase
          .from('engagement_order_items')
          .update({ status: 'cancelled' })
          .eq('engagement_order_id', eo.id)
          .not('status', 'in', '("completed","cancelled","failed")');
      }

      // 5. Update single order statuses
      const { error: singleError } = await supabase
        .from('orders')
        .update({ status: 'cancelled' })
        .eq('user_id', targetUser.user_id)
        .not('status', 'in', '("completed","cancelled","failed")');

      if (singleError) throw singleError;

      // 6. Update engagement order statuses
      const { error: engagementError } = await supabase
        .from('engagement_orders')
        .update({ status: 'cancelled' })
        .eq('user_id', targetUser.user_id)
        .not('status', 'in', '("completed","cancelled","failed")');

      if (engagementError) throw engagementError;

      // 7. Optional refund - simple implementation (just log for now, complex calculation needed for precise refund)
      if (refund) {
        // Calculate rough refund based on order prices
        const singleTotal = (singleOrders || []).reduce((sum, o) => sum + (o.price || 0), 0);
        const engagementTotal = (engagementOrders || []).reduce((sum, o) => sum + (o.total_price || 0), 0);
        const totalRefund = singleTotal + engagementTotal;

        if (totalRefund > 0) {
          // Get current wallet
          const { data: wallet } = await supabase
            .from('wallets')
            .select('balance')
            .eq('user_id', targetUser.user_id)
            .single();

          const newBalance = (wallet?.balance || 0) + totalRefund;

          await supabase
            .from('wallets')
            .update({ balance: newBalance })
            .eq('user_id', targetUser.user_id);

          await supabase.from('transactions').insert({
            user_id: targetUser.user_id,
            type: 'refund',
            amount: totalRefund,
            balance_after: newBalance,
            description: 'Admin cancelled all orders - refund',
            status: 'completed',
          });
        }
      }
    },
    onSuccess: () => {
      toast.success('All orders cancelled!');
      setCancelUser(null);
      setRefundOnCancel(false);
      queryClient.invalidateQueries({ queryKey: ['admin-all-users-with-subs'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  // Helper to check if user has paused orders
  const hasPausedOrders = (u: UserProfile) => {
    return (u.orderCounts?.singlePaused || 0) + (u.orderCounts?.engagementPaused || 0) > 0;
  };

  // Helper to check if user has active orders
  const hasActiveOrders = (u: UserProfile) => {
    return (u.orderCounts?.singleActive || 0) + (u.orderCounts?.engagementActive || 0) > 0;
  };

  // Total active orders for a user
  const getTotalActiveOrders = (u: UserProfile) => {
    return (u.orderCounts?.singleActive || 0) + (u.orderCounts?.engagementActive || 0);
  };

  // Filter users based on tab
  const getFilteredUsers = () => {
    let filtered = users || [];

    // Search filter
    if (searchQuery) {
      filtered = filtered.filter(
        (u) =>
          u.email.toLowerCase().includes(searchQuery.toLowerCase()) ||
          u.full_name?.toLowerCase().includes(searchQuery.toLowerCase())
      );
    }

    return filtered;
  };

  const filteredUsers = getFilteredUsers();

  // Stats
  const totalBalance = users?.reduce((sum, u) => sum + (u.wallet?.balance || 0), 0) || 0;

  // Wait for auth to load before checking admin status
  if (authLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center min-h-[60vh]">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </DashboardLayout>
    );
  }

  if (!isAdmin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <DashboardLayout>
      <div className="space-y-6 px-2 sm:px-4 lg:px-6 pb-8">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <Link
            to="/admin"
            className="w-10 h-10 rounded-xl bg-muted flex items-center justify-center hover:bg-muted/80 transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl sm:text-3xl font-bold">User Management</h1>
            <p className="text-sm text-muted-foreground">
              View and manage all user accounts
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="glass-card">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-foreground/10 flex items-center justify-center">
                  <Users className="h-5 w-5 text-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{users?.length || 0}</p>
                  <p className="text-xs text-muted-foreground">Total Users</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Tabs & Search */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative max-w-xs">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-10 rounded-xl"
            />
          </div>
        </div>

        {/* Users Grid */}
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : filteredUsers && filteredUsers.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredUsers.map((u) => (
              <Card
                key={u.id}
                className="glass-card hover:border-primary/30 transition-all group"
              >
                <CardContent className="p-5">
                  <div className="flex items-start gap-4">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center text-lg font-bold text-primary">
                      {u.email.charAt(0).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <h3 className="font-semibold truncate">
                          {u.full_name || 'Unnamed'}
                        </h3>
                        {u.role === 'admin' && (
                          <Badge className="bg-foreground/20 text-foreground text-[10px] h-5">
                            <Shield className="h-3 w-3 mr-1" />
                            Admin
                          </Badge>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
                        <Mail className="h-3 w-3" />
                        {u.email}
                      </p>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-3 p-3 rounded-xl bg-muted/50">
                    <div className="text-center">
                      <p className="text-lg font-bold text-success">
                        ₹{((u.wallet?.balance || 0) * 83.5).toFixed(2)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">Balance</p>
                    </div>
                    <div className="text-center border-x border-border">
                      <p className="text-lg font-bold">
                        ₹{((u.wallet?.total_spent || 0) * 83.5).toFixed(2)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">Spent</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-primary">
                        ₹{((u.wallet?.total_deposited || 0) * 83.5).toFixed(2)}
                      </p>
                      <p className="text-[10px] text-muted-foreground">Deposited</p>
                    </div>
                  </div>

                  {/* Order Count Badge */}
                  {(hasActiveOrders(u) || hasPausedOrders(u)) && (
                    <div className="mt-3 p-2.5 rounded-lg bg-muted/50 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <ShoppingCart className="h-4 w-4 text-muted-foreground" />
                        <span className="text-sm">
                          {getTotalActiveOrders(u) > 0 && (
                            <span className="text-primary font-medium">{getTotalActiveOrders(u)} Active</span>
                          )}
                          {getTotalActiveOrders(u) > 0 && hasPausedOrders(u) && ' • '}
                          {hasPausedOrders(u) && (
                            <span className="text-warning font-medium">
                              {(u.orderCounts?.singlePaused || 0) + (u.orderCounts?.engagementPaused || 0)} Paused
                            </span>
                          )}
                        </span>
                      </div>
                    </div>
                  )}

                  <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(u.created_at), 'MMM d, yyyy')}
                    </p>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setSelectedUser(u)}
                        className="h-8 w-8 rounded-lg"
                        title="Manage Balance"
                      >
                        <Wallet className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleAdminMutation.mutate(u)}
                        className={`h-8 w-8 rounded-lg ${u.role === 'admin' ? 'text-foreground' : ''}`}
                        title="Toggle Admin"
                      >
                        <Shield className="h-4 w-4" />
                      </Button>
                      {/* Pause/Resume Button */}
                      {hasPausedOrders(u) ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => resumeAllOrdersMutation.mutate(u)}
                          disabled={resumeAllOrdersMutation.isPending}
                          className="h-8 w-8 rounded-lg text-success hover:text-success"
                          title="Resume All Orders"
                        >
                          {resumeAllOrdersMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Play className="h-4 w-4" />
                          )}
                        </Button>
                      ) : hasActiveOrders(u) ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setPauseUser(u)}
                          className="h-8 w-8 rounded-lg text-warning hover:text-warning"
                          title="Pause All Orders"
                        >
                          <Pause className="h-4 w-4" />
                        </Button>
                      ) : null}
                      {/* Cancel Button */}
                      {(hasActiveOrders(u) || hasPausedOrders(u)) && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setCancelUser(u)}
                          className="h-8 w-8 rounded-lg text-destructive hover:text-destructive"
                          title="Cancel All Orders"
                        >
                          <Ban className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        ) : (
          <Card className="glass-card p-12 text-center">
            <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">No users found</p>
          </Card>
        )}

        {/* Balance Dialog */}
        <Dialog
          open={!!selectedUser}
          onOpenChange={(open) => !open && setSelectedUser(null)}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5 text-primary" />
                Manage Balance
              </DialogTitle>
            </DialogHeader>
            {selectedUser && (
              <div className="space-y-4 py-4">
                <div className="p-4 rounded-xl bg-muted/50 text-center">
                  <p className="text-xs text-muted-foreground mb-1">
                    {selectedUser.email}
                  </p>
                  <p className="text-3xl font-bold text-success">
                    ₹{((selectedUser.wallet?.balance || 0) * 83.5).toFixed(2)}
                  </p>
                  <p className="text-xs text-muted-foreground">Current Balance</p>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <Button
                    variant={balanceAction === 'add' ? 'default' : 'outline'}
                    onClick={() => setBalanceAction('add')}
                    className="rounded-xl gap-2"
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </Button>
                  <Button
                    variant={balanceAction === 'subtract' ? 'default' : 'outline'}
                    onClick={() => setBalanceAction('subtract')}
                    className="rounded-xl gap-2"
                  >
                    <Minus className="h-4 w-4" />
                    Subtract
                  </Button>
                </div>

                <div className="space-y-2">
                  <Label>Amount (₹ INR)</Label>
                  <Input
                    type="number"
                    step="1"
                    placeholder="e.g. 500"
                    value={balanceAmount}
                    onChange={(e) => setBalanceAmount(e.target.value)}
                    className="h-11 rounded-xl"
                  />
                  <p className="text-[10px] text-muted-foreground">Wallet credit converted at ₹83.5 / $1</p>
                </div>

                {/* Self-Test Panel */}
                <div className="rounded-xl border border-dashed p-3 space-y-2 bg-muted/30">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold">Admin Fund Self-Test</p>
                      <p className="text-[10px] text-muted-foreground">+₹1 then -₹1, verifies wallet & transactions</p>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={selfTestRunning}
                      onClick={async () => {
                        if (!selectedUser) return;
                        let tuid: string;
                        try { tuid = resolveUserId(selectedUser); }
                        catch (e) { toast.error((e as Error).message); return; }
                        setSelfTestRunning(true);
                        setSelfTestSteps([]);
                        const push = (s: { label: string; ok: boolean | null; detail?: string }) =>
                          setSelfTestSteps((prev) => [...prev, s]);
                        const RATE = 83.5;
                        const delta = Math.trunc((1 / RATE) * 10000) / 10000;
                        const insertedTxIds: string[] = [];
                        let b0: number | null = null;
                        let walletMutated = false;

                        const cleanup = async (reason: string) => {
                          try {
                            if (walletMutated && b0 !== null) {
                              await supabase.from('wallets')
                                .update({ balance: b0 }).eq('user_id', tuid);
                            }
                            if (insertedTxIds.length) {
                              await supabase.from('transactions').delete().in('id', insertedTxIds);
                            }
                            push({ label: `Rollback (${reason}) — balance restored & self-test rows removed`, ok: true });
                          } catch (ce) {
                            const cm = ce instanceof Error ? ce.message : String(ce);
                            push({ label: `Rollback FAILED — manual review needed`, ok: false, detail: cm });
                          }
                        };

                        try {
                          const { data: w0, error: e0 } = await supabase.from('wallets')
                            .select('balance').eq('user_id', tuid).maybeSingle();
                          if (e0) throw new Error('read: ' + e0.message);
                          b0 = Number(w0?.balance || 0);
                          push({ label: `1. Initial balance = $${b0.toFixed(4)}`, ok: true });

                          const b1 = Math.trunc((b0 + delta) * 10000) / 10000;
                          const { error: eu1 } = await supabase.from('wallets')
                            .update({ balance: b1 }).eq('user_id', tuid);
                          push({ label: '2. Update wallet (+₹1)', ok: !eu1, detail: eu1?.message });
                          if (eu1) throw eu1;
                          walletMutated = true;

                          const { data: ti1, error: et1 } = await supabase.from('transactions').insert({
                            user_id: tuid, type: 'deposit', amount: delta,
                            balance_after: b1, status: 'completed',
                            description: '[ADMIN SELF-TEST] +₹1 (auto-reverted)',
                          }).select('id').single();
                          push({ label: '3. Insert deposit transaction', ok: !et1, detail: et1?.message });
                          if (et1) throw et1;
                          if (ti1?.id) insertedTxIds.push(ti1.id);

                          const { data: w1 } = await supabase.from('wallets').select('balance')
                            .eq('user_id', tuid).maybeSingle();
                          const okAdd = Math.abs(Number(w1?.balance || 0) - b1) < 0.0001;
                          push({ label: `4. Verify balance = $${b1.toFixed(4)}`, ok: okAdd, detail: `got $${Number(w1?.balance).toFixed(4)}` });

                          const b2 = Math.trunc((b1 - delta) * 10000) / 10000;
                          const { error: eu2 } = await supabase.from('wallets')
                            .update({ balance: b2 }).eq('user_id', tuid);
                          push({ label: '5. Update wallet (-₹1)', ok: !eu2, detail: eu2?.message });
                          if (eu2) throw eu2;

                          const { data: ti2, error: et2 } = await supabase.from('transactions').insert({
                            user_id: tuid, type: 'withdrawal', amount: -delta,
                            balance_after: b2, status: 'completed',
                            description: '[ADMIN SELF-TEST] -₹1 (auto-reverted)',
                          }).select('id').single();
                          push({ label: '6. Insert withdrawal transaction', ok: !et2, detail: et2?.message });
                          if (et2) throw et2;
                          if (ti2?.id) insertedTxIds.push(ti2.id);

                          const { data: w2 } = await supabase.from('wallets').select('balance')
                            .eq('user_id', tuid).maybeSingle();
                          const okSub = Math.abs(Number(w2?.balance || 0) - b0) < 0.0001;
                          push({ label: `7. Verify balance restored = $${b0.toFixed(4)}`, ok: okSub, detail: `got $${Number(w2?.balance).toFixed(4)}` });

                          push({ label: `8. Recorded ${insertedTxIds.length} self-test transaction(s) — cleaning up`, ok: true });

                          // Always remove the self-test transaction rows so the user never sees them.
                          await cleanup('test complete');

                          toast.success('Self-test finished ✔ (no permanent changes)');
                          queryClient.invalidateQueries({ queryKey: ['admin-all-users-with-subs'] });
                        } catch (err) {
                          const msg = err instanceof Error ? err.message : String(err);
                          push({ label: 'ABORTED', ok: false, detail: msg });
                          await cleanup('error');
                          toast.error('Self-test failed: ' + msg);
                        } finally {
                          setSelfTestRunning(false);
                        }
                      }}
                    >
                      {selfTestRunning && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
                      Run Self-Test
                    </Button>
                  </div>
                  {selfTestSteps.length > 0 && (
                    <ul className="space-y-1 text-[11px] max-h-48 overflow-auto pt-1">
                      {selfTestSteps.map((s, i) => (
                        <li key={i} className={s.ok === false ? 'text-red-500' : s.ok ? 'text-green-600' : 'text-muted-foreground'}>
                          {s.ok === true ? '✅' : s.ok === false ? '❌' : '•'} {s.label}
                          {s.detail && <span className="text-muted-foreground"> — {s.detail}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => { setSelectedUser(null); setSelfTestSteps([]); }}>
                Cancel
              </Button>
              <Button
                onClick={() => updateBalanceMutation.mutate()}
                disabled={updateBalanceMutation.isPending || !balanceAmount}
              >
                {updateBalanceMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                {balanceAction === 'add' ? 'Add' : 'Subtract'} ₹{balanceAmount || '0'}
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Pause All Orders Dialog */}
        <Dialog
          open={!!pauseUser}
          onOpenChange={(open) => !open && setPauseUser(null)}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-warning">
                <Pause className="h-5 w-5" />
                Pause All Orders
              </DialogTitle>
            </DialogHeader>
            {pauseUser && (
              <div className="space-y-4 py-4">
                <div className="p-4 rounded-xl bg-muted/50 text-center">
                  <p className="font-medium">{pauseUser.full_name || pauseUser.email}</p>
                  <p className="text-xs text-muted-foreground">{pauseUser.email}</p>
                  <div className="mt-3 flex justify-center gap-4 text-sm">
                    <span>{pauseUser.orderCounts?.singleActive || 0} Single Orders</span>
                    <span>{pauseUser.orderCounts?.engagementActive || 0} Engagement Orders</span>
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-sm text-warning">
                  <p className="font-medium mb-1">This will pause ALL delivery schedules for this user.</p>
                  <p className="text-warning/80">Runs scheduled during pause will be skipped (not delivered). Resume to continue deliveries.</p>
                </div>
              </div>
            )}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setPauseUser(null)}>
                Cancel
              </Button>
              <Button
                variant="warning"
                onClick={() => pauseUser && pauseAllOrdersMutation.mutate(pauseUser)}
                disabled={pauseAllOrdersMutation.isPending}
              >
                {pauseAllOrdersMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Pause All Orders
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {/* Cancel All Orders Dialog */}
        <Dialog
          open={!!cancelUser}
          onOpenChange={(open) => {
            if (!open) {
              setCancelUser(null);
              setRefundOnCancel(false);
            }
          }}
        >
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <Ban className="h-5 w-5" />
                Cancel All Orders
              </DialogTitle>
            </DialogHeader>
            {cancelUser && (
              <div className="space-y-4 py-4">
                <div className="p-4 rounded-xl bg-muted/50 text-center">
                  <p className="font-medium">{cancelUser.full_name || cancelUser.email}</p>
                  <p className="text-xs text-muted-foreground">{cancelUser.email}</p>
                  <div className="mt-3 text-sm">
                    <p>Orders to cancel:</p>
                    <p className="font-medium mt-1">
                      {(cancelUser.orderCounts?.singleActive || 0) + (cancelUser.orderCounts?.singlePaused || 0)} single,{' '}
                      {(cancelUser.orderCounts?.engagementActive || 0) + (cancelUser.orderCounts?.engagementPaused || 0)} engagement
                    </p>
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-sm text-destructive flex items-start gap-2">
                  <AlertTriangle className="h-5 w-5 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="font-medium">This action cannot be undone!</p>
                    <p className="text-destructive/80">All pending deliveries will be stopped permanently.</p>
                  </div>
                </div>
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="refund"
                    checked={refundOnCancel}
                    onCheckedChange={(checked) => setRefundOnCancel(checked === true)}
                  />
                  <label
                    htmlFor="refund"
                    className="text-sm font-medium leading-none cursor-pointer"
                  >
                    Refund remaining balance
                  </label>
                </div>
              </div>
            )}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-4">
              <Button variant="outline" onClick={() => setCancelUser(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => cancelUser && cancelAllOrdersMutation.mutate({ targetUser: cancelUser, refund: refundOnCancel })}
                disabled={cancelAllOrdersMutation.isPending}
              >
                {cancelAllOrdersMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Cancel All Orders
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </DashboardLayout>
  );
}
