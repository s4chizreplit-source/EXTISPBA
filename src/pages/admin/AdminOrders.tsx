import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useToast } from '@/hooks/use-toast';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  ShoppingCart,
  Search,
  Loader2,
  ArrowLeft,
  Leaf,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Package,
  DollarSign,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
} from 'lucide-react';
import { Link, Navigate } from 'react-router-dom';
import type { OrganicRun } from '@/lib/supabase';

export default function AdminOrders() {
  const { isAdmin, isLoading: authLoading } = useAuth();
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [expandedOrder, setExpandedOrder] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const cancelOrderMutation = useMutation({
    mutationFn: async (orderId: string) => {
      const { data, error } = await supabase.functions.invoke('cancel-order', {
        body: { order_id: orderId }
      });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['admin-all-orders'] });
      queryClient.invalidateQueries({ queryKey: ['admin-organic-runs'] });
      toast({
        title: "Order Cancelled",
        description: `Refunded: ₹${((data.refundAmount || 0) * 83.5).toFixed(2)} (${data.refundedQuantity || 0} units)`,
      });
    },
    onError: (error: any) => {
      toast({
        title: "Cancellation Failed",
        description: error.message,
        variant: "destructive"
      });
    }
  });

  const { data: orders, isLoading } = useQuery({
    queryKey: ['admin-all-orders'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('*, service:services(name, category)')
        .order('created_at', { ascending: false })
        .limit(100);

      if (error) throw error;
      return data;
    },
  });

  const { data: organicRuns } = useQuery({
    queryKey: ['admin-organic-runs', expandedOrder],
    queryFn: async () => {
      if (!expandedOrder) return [];
      const { data, error } = await supabase
        .from('organic_run_schedule')
        .select('*')
        .eq('order_id', expandedOrder)
        .order('run_number', { ascending: true });

      if (error) throw error;
      return data as OrganicRun[];
    },
    enabled: !!expandedOrder,
  });

  const filteredOrders = orders?.filter((order) => {
    const matchesSearch =
      order.order_number.toString().includes(searchQuery) ||
      order.link.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesStatus =
      statusFilter === 'All' || order.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-foreground/20 text-foreground';
      case 'processing':
        return 'bg-muted text-muted-foreground';
      case 'pending':
        return 'bg-secondary text-muted-foreground';
      case 'failed':
        return 'bg-muted text-muted-foreground';
      case 'partial':
        return 'bg-secondary text-muted-foreground';
      case 'cancelled':
        return 'bg-muted text-muted-foreground';
      default:
        return 'bg-muted text-muted-foreground';
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return CheckCircle2;
      case 'processing':
        return Clock;
      case 'pending':
        return Clock;
      case 'failed':
        return XCircle;
      case 'partial':
        return AlertTriangle;
      case 'cancelled':
        return XCircle;
      default:
        return Clock;
    }
  };

  const statusFilters = [
    'All',
    'pending',
    'processing',
    'completed',
    'partial',
    'failed',
    'cancelled',
  ];

  // Stats
  const totalRevenue =
    orders?.reduce((sum, o) => sum + Number(o.price), 0) || 0;
  const completedCount =
    orders?.filter((o) => o.status === 'completed').length || 0;
  const processingCount =
    orders?.filter((o) => o.status === 'processing').length || 0;
  const organicCount =
    orders?.filter((o) => o.is_organic_mode).length || 0;

  // INSTANT RENDER - No blocking loader

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
            <h1 className="text-2xl sm:text-3xl font-bold">All Orders</h1>
            <p className="text-sm text-muted-foreground">
              View and manage all platform orders
            </p>
          </div>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Card className="glass-card">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-foreground/10 flex items-center justify-center">
                  <ShoppingCart className="h-5 w-5 text-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{orders?.length || 0}</p>
                  <p className="text-xs text-muted-foreground">Total Orders</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-card">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-foreground/10 flex items-center justify-center">
                  <DollarSign className="h-5 w-5 text-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">₹{(totalRevenue * 83.5).toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground">Revenue</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-card">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-foreground/10 flex items-center justify-center">
                  <CheckCircle2 className="h-5 w-5 text-foreground" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{completedCount}</p>
                  <p className="text-xs text-muted-foreground">Completed</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card className="glass-card">
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                  <Leaf className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <p className="text-2xl font-bold">{organicCount}</p>
                  <p className="text-xs text-muted-foreground">Organic</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-4">
          <div className="relative flex-1 max-w-md">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by order # or link..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 h-11 rounded-xl"
            />
          </div>
          <div className="flex gap-2 flex-wrap">
            {statusFilters.map((status) => (
              <button
                key={status}
                onClick={() => setStatusFilter(status)}
                className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${statusFilter === status
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
              >
                {status.charAt(0).toUpperCase() + status.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {/* Orders */}
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        ) : filteredOrders && filteredOrders.length > 0 ? (
          <div className="space-y-3">
            {filteredOrders.map((order: any) => {
              const StatusIcon = getStatusIcon(order.status);
              return (
                <Card
                  key={order.id}
                  className="glass-card overflow-hidden hover:border-primary/20 transition-all"
                >
                  <div
                    className="p-4 sm:p-5 cursor-pointer"
                    onClick={() =>
                      order.is_organic_mode &&
                      setExpandedOrder(
                        expandedOrder === order.id ? null : order.id
                      )
                    }
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                      <div className="flex items-center gap-4 flex-1">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center shrink-0">
                          <span className="text-sm font-mono font-bold text-primary">
                            #{order.order_number}
                          </span>
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="font-semibold truncate">
                              {order.service?.name || 'Unknown Service'}
                            </h3>
                            {order.is_organic_mode && (
                              <Badge className="bg-success/20 text-success text-[10px] gap-1">
                                <Leaf className="h-3 w-3" />
                                Organic
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate flex items-center gap-1 mt-1">
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            {order.link}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 sm:gap-6">
                        <div className="text-right">
                          <p className="font-bold">
                            {order.quantity.toLocaleString()}
                          </p>
                          <p className="text-xs text-muted-foreground">qty</p>
                        </div>
                        <div className="text-right">
                          <p className="font-bold text-primary">
                            ₹{(Number(order.price) * 83.5).toFixed(2)}
                          </p>
                          <p className="text-xs text-muted-foreground">price</p>
                        </div>
                        <Badge
                          className={`${getStatusColor(order.status)} gap-1`}
                        >
                          <StatusIcon className="h-3 w-3" />
                          {order.status}
                        </Badge>

                        {order.status !== 'cancelled' && order.status !== 'failed' && order.status !== 'completed' && (
                          <div onClick={(e) => e.stopPropagation()}>
                            <AlertDialog>
                              <AlertDialogTrigger asChild>
                                <Button variant="outline" size="sm" className="h-7 text-xs text-destructive border-destructive hover:bg-destructive/10 hover:text-destructive">
                                  Cancel & Refund
                                </Button>
                              </AlertDialogTrigger>
                              <AlertDialogContent>
                                <AlertDialogHeader>
                                  <AlertDialogTitle>Cancel Order #{order.order_number}?</AlertDialogTitle>
                                  <AlertDialogDescription>
                                    This will cancel all pending runs and immediately refund the remaining unspent amount to the user's wallet.
                                  </AlertDialogDescription>
                                </AlertDialogHeader>
                                <AlertDialogFooter>
                                  <AlertDialogCancel>Keep Order</AlertDialogCancel>
                                  <AlertDialogAction
                                    onClick={() => cancelOrderMutation.mutate(order.id)}
                                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  >
                                    {cancelOrderMutation.isPending && order.id === cancelOrderMutation.variables ? (
                                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                                    ) : null}
                                    Yes, Cancel & Refund
                                  </AlertDialogAction>
                                </AlertDialogFooter>
                              </AlertDialogContent>
                            </AlertDialog>
                          </div>
                        )}
                        {order.is_organic_mode && (
                          <div className="text-muted-foreground">
                            {expandedOrder === order.id ? (
                              <ChevronUp className="h-5 w-5" />
                            ) : (
                              <ChevronDown className="h-5 w-5" />
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {expandedOrder === order.id && order.is_organic_mode && (
                    <div className="border-t border-border p-4 sm:p-5 bg-muted/30">
                      <div className="flex items-center gap-2 mb-4">
                        <Leaf className="h-4 w-4 text-success" />
                        <h4 className="font-semibold text-sm">
                          Organic Delivery Schedule
                        </h4>
                        <Badge variant="secondary" className="text-[10px]">
                          {organicRuns?.length || 0} runs
                        </Badge>
                      </div>

                      {organicRuns && organicRuns.length > 0 ? (
                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
                          {organicRuns.map((run) => (
                            <div
                              key={run.id}
                              className={`p-3 rounded-xl ${run.status === 'completed'
                                  ? 'bg-success/10 border border-success/20'
                                  : run.status === 'started'
                                    ? 'bg-warning/10 border border-warning/20'
                                    : 'bg-background border border-border'
                                }`}
                            >
                              <div className="flex items-center justify-between mb-2">
                                <span className="text-xs font-medium">
                                  Run #{run.run_number}
                                </span>
                                <Badge
                                  className={`text-[10px] h-5 ${getStatusColor(
                                    run.status
                                  )}`}
                                >
                                  {run.status}
                                </Badge>
                              </div>
                              <p className="text-lg font-bold text-foreground">
                                {run.quantity_to_send}
                              </p>
                              <p className="text-[10px] text-muted-foreground">
                                {new Date(run.scheduled_at).toLocaleString()}
                              </p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">
                          Loading schedule...
                        </p>
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        ) : (
          <Card className="glass-card p-12 text-center">
            <ShoppingCart className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">No orders found</p>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
