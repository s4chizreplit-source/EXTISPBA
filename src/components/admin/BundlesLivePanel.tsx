import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sparkles, ArrowUpRight, Wifi, Loader2 } from 'lucide-react';

interface BundleItem {
  id: string;
  engagement_type: string;
  ratio_percent: number | null;
  is_base: boolean | null;
  price_per_k: number | null;
  service: { id: string; name: string; price: number } | null;
}

interface Bundle {
  id: string;
  name: string;
  platform: string;
  is_active: boolean;
  created_at: string;
  items: BundleItem[];
}

/**
 * Live admin view: jab bhi /admin/bundles me bundle/item add ya price change ho,
 * yahaan turant (realtime) dikh jata hai bina refresh kiye.
 */
export function BundlesLivePanel() {
  const queryClient = useQueryClient();

  const { data: bundles, isLoading } = useQuery({
    queryKey: ['admin-services-bundles-live'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_bundles')
        .select(`
          id, name, platform, is_active, created_at,
          items:bundle_items(
            id, engagement_type, ratio_percent, is_base, price_per_k,
            service:services(id, name, price)
          )
        `)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as unknown as Bundle[];
    },
  });

  // Realtime: any change in engagement_bundles / bundle_items / services → refetch
  useEffect(() => {
    const invalidate = () =>
      queryClient.invalidateQueries({ queryKey: ['admin-services-bundles-live'] });

    const channel = supabase
      .channel('admin-bundles-services-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'engagement_bundles' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bundle_items' }, invalidate)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'services' }, () => {
        invalidate();
        queryClient.invalidateQueries({ queryKey: ['admin-all-services'] });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  return (
    <Card className="glass-card border-2 border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Sparkles className="h-5 w-5 text-primary" />
            Live Bundles
            <Badge variant="outline" className="ml-2 gap-1 text-success border-success/30 bg-success/5">
              <Wifi className="h-3 w-3" />
              Realtime
            </Badge>
          </CardTitle>
          <Link to="/admin/bundles">
            <Button variant="outline" size="sm" className="gap-1">
              Open Bundles <ArrowUpRight className="h-3.5 w-3.5" />
            </Button>
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">
          Naye bundle / engagement type yahaan turant dikh jate hain. Per-1000 price har service ke against editable hai (neeche Services table me).
        </p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-primary" />
          </div>
        ) : !bundles || bundles.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            Abhi koi bundle nahi hai. /admin/bundles se banao.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {bundles.map((b) => (
              <div
                key={b.id}
                className="rounded-xl border border-border bg-card/40 p-4 hover:border-primary/40 transition-colors"
              >
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <div className="font-semibold flex items-center gap-2">
                      {b.name}
                      <Badge variant="outline" className="text-[10px] uppercase">
                        {b.platform}
                      </Badge>
                      {!b.is_active && (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground">
                          inactive
                        </Badge>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      {b.items?.length || 0} engagement types
                    </p>
                  </div>
                </div>

                <div className="space-y-1.5">
                  {(b.items || []).map((it) => (
                    <div
                      key={it.id}
                      className="flex items-center justify-between text-xs rounded-md bg-muted/30 px-2.5 py-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${it.is_base ? 'border-primary text-primary' : ''}`}
                        >
                          {it.engagement_type}
                        </Badge>
                        <span className="truncate text-muted-foreground">
                          {it.service ? it.service.name : 'No service linked'}
                        </span>
                      </div>
                      {(() => {
                        const effective =
                          it.price_per_k != null && Number(it.price_per_k) > 0
                            ? Number(it.price_per_k)
                            : it.service?.price ?? null;
                        const isAdminFixed = it.price_per_k != null && Number(it.price_per_k) > 0;
                        return (
                          <span
                            className={`font-mono font-semibold shrink-0 ml-2 ${isAdminFixed ? 'text-primary' : 'text-muted-foreground'}`}
                            title={isAdminFixed ? 'Admin-set bundle price' : 'Falls back to linked service price'}
                          >
                            {effective != null ? `₹${(effective * 83.5).toFixed(2)}/1k` : '—'}
                            {isAdminFixed && <span className="text-[9px] ml-1">FIXED</span>}
                          </span>
                        );
                      })()}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
