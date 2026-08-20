import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';

async function apiFetch(path: string, opts?: RequestInit) {
  const r = await fetch(path, { credentials: 'include', ...opts });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((data as any)?.error || r.statusText);
  return data;
}
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
      const rows = await apiFetch('/api/admin/users');
      return (rows as any[]).map((u: any) => ({
        ...u,
        wallet: {
          balance: u.balance,
          total_deposited: u.total_deposited,
          total_spent: u.total_spent,
        },
        orderCounts: {
          singleActive: Number(u.active_single_orders),
          singlePaused: Number(u.paused_single_orders),
          engagementActive: Number(u.active_engagement_orders),
          engagementPaused: Number(u.paused_engagement_orders),
        },
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
      const inrAmount = parseFloat(balanceAmount);
      if (!inrAmount || inrAmount <= 0) throw new Error('Enter a valid INR amount');
      await apiFetch(`/api/admin/users/${targetUserId}/balance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: balanceAction, inr_amount: inrAmount }),
      });
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
      await apiFetch(`/api/admin/users/${targetUser.user_id}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });
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
    mutationFn: (targetUser: UserProfile) =>
      apiFetch(`/api/admin/users/${targetUser.user_id}/pause-orders`, { method: 'POST' }),
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
    mutationFn: (targetUser: UserProfile) =>
      apiFetch(`/api/admin/users/${targetUser.user_id}/resume-orders`, { method: 'POST' }),
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
    mutationFn: ({ targetUser, refund }: { targetUser: UserProfile; refund: boolean }) =>
      apiFetch(`/api/admin/users/${targetUser.user_id}/cancel-orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refund }),
      }),
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
                        try {
                          const { steps } = await apiFetch(`/api/admin/users/${tuid}/self-test`, { method: 'POST' });
                          setSelfTestSteps(steps || []);
                          const allOk = (steps || []).every((s: any) => s.ok !== false);
                          if (allOk) toast.success('Self-test finished ✔ (no permanent changes)');
                          else toast.error('Self-test had failures — check steps');
                          queryClient.invalidateQueries({ queryKey: ['admin-all-users-with-subs'] });
                        } catch (err) {
                          toast.error('Self-test failed: ' + (err as Error).message);
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
