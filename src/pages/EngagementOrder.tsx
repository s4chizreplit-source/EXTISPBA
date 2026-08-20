import { useState, useMemo, useEffect, useCallback, memo, lazy, Suspense } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCurrency } from "@/hooks/useCurrency";
import { useGlobalMarkup } from "@/hooks/useGlobalMarkup";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { PlatformSelector } from "@/components/engagement/PlatformSelector";
import { QuantitySelector } from "@/components/engagement/QuantitySelector";
import { EngagementTypeCard } from "@/components/engagement/EngagementTypeCard";
import { DrawableGrowthChart } from "@/components/engagement/DrawableGrowthChart";
import { AIEngagementChat } from "@/components/engagement/AIEngagementChat";
import { PreOrderRatioWarning } from "@/components/engagement/PreOrderRatioWarning";

// Heavy preview components — lazy-loaded behind the "Show delivery preview" toggle
const LiveGrowthChart = lazy(() =>
  import("@/components/engagement/LiveGrowthChart").then((m) => ({ default: m.LiveGrowthChart }))
);
const DeliveryPreview = lazy(() =>
  import("@/components/engagement/DeliveryPreview").then((m) => ({ default: m.DeliveryPreview }))
);

import {
  EngagementType,
  EngagementConfig,
  DEFAULT_RATIOS,
  DEFAULT_ORGANIC_SETTINGS,
  EngagementBundle,
  BundleItem
} from "@/lib/engagement-types";
import {
  ControlPoint,
  DrawModeState,
  createInitialPoints,
  curveToSchedule,
  calculateQuantitiesFromCurve,
} from "@/lib/curve-to-schedule";
import { Loader2, Rocket, Link as LinkIcon, Wallet, RefreshCw, Brain, Percent, Eye, EyeOff, Lock } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { useDebounce } from "@/hooks/useDebounce";
import { FullOrganicConfig, effectiveMinimum } from "@/lib/organic-algorithm";

type EngagementConfigs = Record<string, EngagementConfig>;

// All possible engagement types - will be filtered based on bundle
const ALL_ENGAGEMENT_TYPES: EngagementType[] = ['views', 'likes', 'comments', 'saves', 'shares', 'reposts', 'followers', 'subscribers', 'watch_hours', 'retweets'];

// Local formatPrice for micro-transactions (USD-only raw formatting)
const formatPriceRaw = (price: number): string => {
  if (price === 0) return '0.00';
  if (price >= 0.01) return price.toFixed(2);
  if (price >= 0.0001) return price.toFixed(4);
  if (price >= 0.000001) return price.toFixed(6);
  return price.toFixed(8);
};

export default function EngagementOrder() {
  const navigate = useNavigate();
  const { user, profile, isLoading: authLoading, isAdmin, wallet, refreshWallet } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { formatPrice, rates } = useCurrency();
  const { applyMarkup } = useGlobalMarkup();

  // Form State
  const [searchParams] = useSearchParams();
  const [platform, setPlatform] = useState('instagram');
  const [link, setLink] = useState(searchParams.get('link') ?? '');

  // Sync link + platform when arriving via ?link=  (and handle ?types= refill)
  useEffect(() => {
    const initial = searchParams.get('link');
    if (initial) {
      setLink(initial);
      const lower = initial.toLowerCase();
      if (lower.includes('instagram.com')) setPlatform('instagram');
      else if (lower.includes('tiktok.com')) setPlatform('tiktok');
      else if (lower.includes('youtube.com') || lower.includes('youtu.be')) setPlatform('youtube');
    }
    // Refill mode: force manual ratios so only the selected type stays enabled
    const rawTypes = searchParams.get('types');
    if (rawTypes || searchParams.get('refill')) {
      setIsAutoRatios(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [showPreview, setShowPreview] = useState(false);
  const [baseQuantity, setBaseQuantity] = useState(10000);
  // Debounce base quantity for expensive recalculations
  const debouncedBaseQuantity = useDebounce(baseQuantity, 200);
  const [previewRefreshKey, setPreviewRefreshKey] = useState(0);
  const [previewSchedules, setPreviewSchedules] = useState<Record<string, { scheduled_at: string; quantity_to_send: number; base_quantity: number; variance_applied: number; peak_multiplier: number }[]>>({});

  // Draw mode state for custom curve editing
  const [drawModeState, setDrawModeState] = useState<DrawModeState>({
    isEnabled: false,
    activeType: null,
    points: {} as Record<EngagementType, ControlPoint[]>,
  });

  // Engagement configs - initialize empty, will be populated when bundle loads
  const [engagements, setEngagements] = useState<EngagementConfigs>({});

  // Local settings toggles (defaulted from localStorage)
  const [isOrganicMode, setIsOrganicMode] = useState(true);
  const [isAutoRatios, setIsAutoRatios] = useState(true);
  // User-saved custom ratios from Settings page (stored in localStorage)
  const [userSavedRatios, setUserSavedRatios] = useState<Record<string, number> | null>(null);

  // Sync with localStorage on load
  useEffect(() => {
    try {
      const savedOrganic = localStorage.getItem('organic_settings');
      if (savedOrganic) {
        const parsed = JSON.parse(savedOrganic);
        if (typeof parsed.isOrganicMode === 'boolean') setIsOrganicMode(parsed.isOrganicMode);
        if (parsed.ratios) setUserSavedRatios(parsed.ratios);
      }
    } catch { /* ignore */ }
  }, []);

  // Realtime: invalidate bundles when admin updates price_per_k or bundle items
  useEffect(() => {
    const channel = supabase
      .channel('user-bundles-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bundle_items' }, () => {
        queryClient.invalidateQueries({ queryKey: ['bundles'] });
        queryClient.invalidateQueries({ queryKey: ['all-bundles-with-items'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'engagement_bundles' }, () => {
        queryClient.invalidateQueries({ queryKey: ['bundles'] });
        queryClient.invalidateQueries({ queryKey: ['all-bundles-with-items'] });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'services' }, () => {
        queryClient.invalidateQueries({ queryKey: ['bundles'] });
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [queryClient]);




  // Fetch ALL active bundles WITH items to know which platforms are available
  const { data: allBundles } = useQuery({
    queryKey: ['all-bundles-with-items'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_bundles')
        .select(`
          platform,
          items:bundle_items(id, service_id)
        `)
        .eq('is_active', true);
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
  });

  // Get unique platforms that have active bundles with engagement items
  const availablePlatforms = useMemo(() => {
    console.log('[EngagementOrder] allBundles:', allBundles);
    if (!allBundles) return [];
    // Show platforms that have at least one bundle with items configured
    const platforms = allBundles
      .filter(b => b.items && b.items.length > 0)
      .map(b => b.platform);
    const result = [...new Set(platforms)];
    console.log('[EngagementOrder] availablePlatforms:', result);
    return result;
  }, [allBundles]);

  // Auto-select first available platform if current selection has no bundles
  useEffect(() => {
    if (availablePlatforms.length > 0 && !availablePlatforms.includes(platform)) {
      setPlatform(availablePlatforms[0]);
    }
  }, [availablePlatforms, platform]);

  // Fetch bundles for selected platform
  const { data: bundles, isLoading: bundlesLoading } = useQuery({
    queryKey: ['bundles', platform],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('engagement_bundles')
        .select(`
          *,
          items:bundle_items(
            *,
            service:services(id, name, price, min_quantity, max_quantity)
          )
        `)
        .eq('platform', platform)
        .eq('is_active', true)
        .order('sort_order');
      if (error) throw error;
      return data as (EngagementBundle & { items: (BundleItem & { service: any })[] })[];
    },
    enabled: !!platform && availablePlatforms.includes(platform),
    staleTime: 5 * 60 * 1000,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  // Get active engagement types from bundle
  const activeEngagementTypes = useMemo<EngagementType[]>(() => {
    if (!bundles || bundles.length === 0) return [];
    const bundle = bundles[0];
    if (!bundle?.items) return [];
    // Return unique engagement types sorted by preferred order
    const types = bundle.items
      .map(item => item.engagement_type as EngagementType);
    const uniqueTypes = [...new Set(types)];

    const PREFERRED_ORDER: Record<string, number> = {
      views: 1,
      likes: 2,
      comments: 3,
      shares: 4,
      reposts: 5,
      saves: 6,
    };

    return uniqueTypes.sort((a, b) => (PREFERRED_ORDER[a] || 99) - (PREFERRED_ORDER[b] || 99));
  }, [bundles]);

  // Base per-type quantities (used as "100%" reference for draw-mode scaling)
  // Use debounced value for expensive calculations
  const baseTypeQuantities = useMemo(() => {
    const base: Record<EngagementType, number> = {} as Record<EngagementType, number>;
    activeEngagementTypes.forEach((type) => {
      // Use user's custom ratio if available from localStorage, else fallback to default
      const userRatio = userSavedRatios?.[type];
      const ratio = typeof userRatio === 'number' ? userRatio : DEFAULT_RATIOS[type];
      base[type] = Math.round(debouncedBaseQuantity * (ratio / 100));
    });
    return base;
  }, [debouncedBaseQuantity, activeEngagementTypes, userSavedRatios]);
  // Fetch ALL active services as fallback for price lookup
  const { data: allServices } = useQuery({
    queryKey: ['all-active-services'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('services')
        .select('id, name, price, min_quantity, max_quantity, category')
        .eq('is_active', true)
        .order('price', { ascending: true });
      if (error) throw error;
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });

  // Get service prices from bundle — with auto-match fallback for unlinked items
  const servicePrices = useMemo(() => {
    if (!bundles || bundles.length === 0) return {};
    const bundle = bundles[0];
    if (!bundle?.items) return {};

    // Keywords to match engagement types in service names
    const typeKeywords: Record<string, string[]> = {
      views: ['view'],
      likes: ['like'],
      comments: ['comment'],
      saves: ['save'],
      shares: ['share'],
      reposts: ['repost'],
      followers: ['follow'],
      subscribers: ['subscrib'],
      watch_hours: ['watch'],
      retweets: ['retweet'],
    };

    const prices: Record<string, { pricePerK: number; serviceId: string | null; minQuantity: number }> = {};
    bundle.items.forEach(item => {
      const keywords = typeKeywords[item.engagement_type] || [item.engagement_type];
      const platName = platform.toLowerCase();
      const matchingServices = (allServices || []).filter(s => {
        const name = s.name?.toLowerCase() || '';
        const cat = s.category?.toLowerCase() || '';
        const matchesPlatform = name.includes(platName) || cat.includes(platName);
        const matchesType = keywords.some(kw => name.includes(kw));
        return matchesPlatform && matchesType;
      });
      const positiveMins = matchingServices.map(s => s.min_quantity ?? 0).filter(n => n > 0);
      const lowestMatchedMin = positiveMins.length > 0 ? Math.min(...positiveMins) : undefined;

      // Admin-set bundle-level per-1000 price overrides everything.
      // Provider rotate ho ya nahi, ye fixed price hi user ko charge hota hai.
      const adminPricePerK =
        item.price_per_k != null && Number(item.price_per_k) > 0
          ? Number(item.price_per_k)
          : null;

      // 1) Try the linked service first, but show the lowest provider minimum across the rotation pool
      if (item.service && (adminPricePerK !== null || item.service.price > 0)) {
        prices[item.engagement_type] = {
          pricePerK: adminPricePerK ?? item.service.price,
          serviceId: item.service.id,
          minQuantity: effectiveMinimum(item.engagement_type, lowestMatchedMin ?? item.service.min_quantity),
        };
        return;
      }

      // 2) Fallback: auto-match from all active services by platform + engagement type
      if (allServices && allServices.length > 0) {
        const matches = matchingServices.filter(s => s.price > 0);

        if (matches.length > 0) {
          // Cheapest service for routing target
          const match = matches.reduce((a, b) => (a.price <= b.price ? a : b));
          // Lowest min across all matching providers (router can rotate)
          const lowestMin = Math.min(...matches.map(s => s.min_quantity ?? 0).filter(n => n > 0));
          prices[item.engagement_type] = {
            pricePerK: adminPricePerK ?? match.price,
            serviceId: match.id,
            minQuantity: effectiveMinimum(item.engagement_type, Number.isFinite(lowestMin) ? lowestMin : match.min_quantity),
          };
          return;
        }
      }

      // 3) Even if linked but price=0, still register the service for order routing
      if (item.service) {
        prices[item.engagement_type] = {
          pricePerK: adminPricePerK ?? item.service.price,
          serviceId: item.service.id,
          minQuantity: effectiveMinimum(item.engagement_type, lowestMatchedMin ?? item.service.min_quantity),
        };
      }
    });
    return prices;
  }, [bundles, allServices, platform, rates]);

  // Update engagement configs when bundle or base quantity changes
  // Use debounced value to prevent excessive recalculations
  useEffect(() => {
    if (!bundles || bundles.length === 0) return;

    const bundle = bundles[0];
    if (!bundle?.items) return;

    // Get all engagement types from bundle items
    const bundleTypes = bundle.items
      .map(item => item.engagement_type as EngagementType);

    const uniqueBundleTypes = [...new Set(bundleTypes)];

    setEngagements((prev) => {
      const updated: EngagementConfigs = {};

      uniqueBundleTypes.forEach((type) => {
        // If auto-ratios is OFF, only enable 'views' by default
        const isEnabledByDefault = isAutoRatios || type === 'views';

        // Use user's custom ratio if available from localStorage, else fallback to default
        const userRatio = userSavedRatios?.[type];
        const ratioPercent = typeof userRatio === 'number' ? userRatio : (DEFAULT_RATIOS[type] ?? 1);

        const ratioQuantity = Math.round(debouncedBaseQuantity * (ratioPercent / 100));

        const serviceData = servicePrices[type];

        // Respect user's base quantity exactly — no auto bump to provider minimum.
        // If it's below provider min, the per-card warning will appear.
        const quantity = ratioQuantity;

        updated[type] = {
          type,
          enabled: prev[type] ? prev[type].enabled : isEnabledByDefault,
          quantity: (isAutoRatios || !prev[type]) ? quantity : prev[type].quantity,
          price: serviceData
            ? (quantity / 1000) * serviceData.pricePerK
            : prev[type]?.price ?? 0,
          serviceId: serviceData?.serviceId ?? prev[type]?.serviceId ?? null,
          minQuantity: serviceData?.minQuantity ?? prev[type]?.minQuantity ?? effectiveMinimum(type),
          // Per-type organic settings
          timeLimitHours: prev[type]?.timeLimitHours ?? DEFAULT_ORGANIC_SETTINGS.timeLimitHours,
          variancePercent: prev[type]?.variancePercent ?? DEFAULT_ORGANIC_SETTINGS.variancePercent,
          peakHoursEnabled: prev[type]?.peakHoursEnabled ?? DEFAULT_ORGANIC_SETTINGS.peakHoursEnabled,
        };
      });
      return updated;
    });
  }, [debouncedBaseQuantity, bundles, servicePrices, userSavedRatios, isAutoRatios]);

  // Refill mode: after engagements populate, enable only the requested type(s)
  const [refillApplied, setRefillApplied] = useState(false);
  useEffect(() => {
    if (refillApplied) return;
    const rawTypes = searchParams.get('types');
    if (!rawTypes) return;
    const wanted = rawTypes.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
    if (!wanted.length) return;
    if (!engagements || Object.keys(engagements).length === 0) return;
    setEngagements(prev => {
      const next: EngagementConfigs = {};
      Object.entries(prev).forEach(([k, cfg]) => {
        next[k] = { ...cfg, enabled: wanted.includes(k.toLowerCase()) };
      });
      return next;
    });
    setRefillApplied(true);
  }, [engagements, searchParams, refillApplied]);


  const handleEngagementChange = useCallback((type: EngagementType, config: EngagementConfig) => {
    setEngagements(prev => ({ ...prev, [type]: config }));
    // Reset draw mode when user manually changes quantity
    if (drawModeState.isEnabled) {
      setDrawModeState(prev => ({
        ...prev,
        points: {
          ...prev.points,
          [type]: createInitialPoints(type, config.quantity),
        },
      }));
    }
  }, [drawModeState.isEnabled]);

  // Real-time: when user drags curve, update quantities instantly (and schedule updates automatically)
  useEffect(() => {
    if (!drawModeState.isEnabled) return;

    const nextQuantities = calculateQuantitiesFromCurve(drawModeState.points, baseTypeQuantities);

    setEngagements((prev) => {
      let changed = false;
      const updated: EngagementConfigs = { ...prev };

      Object.keys(prev).forEach((type) => {
        const engType = type as EngagementType;
        const desired = nextQuantities[engType];
        if (typeof desired !== 'number' || Number.isNaN(desired)) return;

        // Clamp to provider/service minimum if present
        const min = updated[engType]?.minQuantity ?? 0;
        const clamped = min > 0 ? Math.max(min, desired) : desired;

        if (clamped === updated[engType]?.quantity) return;

        const prevQty = updated[engType]?.quantity || 0;
        const pricePerK = prevQty > 0 ? ((updated[engType]?.price || 0) * 1000) / prevQty : 0;

        updated[engType] = {
          ...updated[engType],
          quantity: clamped,
          price: pricePerK > 0 ? (clamped / 1000) * pricePerK : updated[engType]?.price || 0,
        };
        changed = true;
      });

      return changed ? updated : prev;
    });
  }, [drawModeState.isEnabled, drawModeState.points, baseTypeQuantities]);

  // Handle curve change from drawable chart (end-of-drag / preset / reset)
  const handleCurveChange = useCallback((type: EngagementType, points: ControlPoint[]) => {
    // Update the draw mode state with new points
    setDrawModeState(prev => ({
      ...prev,
      points: { ...prev.points, [type]: points },
    }));
    // Refresh key kept for any downstream reset behavior
    setPreviewRefreshKey(k => k + 1);
  }, []);

  const handleScheduleChange = useCallback((payload: {
    schedules: FullOrganicConfig[];
    customQuantities: Record<string, number>;
  }) => {
    const nextSchedules = payload.schedules.reduce((acc, schedule) => {
      acc[schedule.engagementType] = schedule.runs.map((run) => {
        const runId = `${schedule.engagementType}-${run.runNumber}`;
        const quantity = payload.customQuantities[runId] ?? run.quantity;

        return {
          scheduled_at: run.scheduledAt.toISOString(),
          quantity_to_send: quantity,
          base_quantity: quantity,
          variance_applied: run.varianceApplied,
          peak_multiplier: run.peakMultiplier,
        };
      });

      return acc;
    }, {} as Record<string, { scheduled_at: string; quantity_to_send: number; base_quantity: number; variance_applied: number; peak_multiplier: number }[]>);

    setPreviewSchedules(nextSchedules);
  }, []);

  // Calculate totals
  const totalPrice = useMemo(() => {
    return Object.values(engagements)
      .filter(e => e.enabled)
      .reduce((sum, e) => sum + e.price, 0);
  }, [engagements]);

  const totalEngagements = useMemo(() => {
    return Object.values(engagements)
      .filter(e => e.enabled)
      .reduce((sum, e) => sum + e.quantity, 0);
  }, [engagements]);

  // Place order mutation
  const placeOrderMutation = useMutation({
    mutationFn: async () => {
      if (!user) throw new Error('Not authenticated');
      if (!link.trim()) throw new Error('Please enter a valid link');

      // Strong client-side validation
      if (!wallet) {
        throw new Error('Wallet not found. Please refresh the page.');
      }

      if (wallet.balance < totalPrice) {
        throw new Error(
          `Insufficient balance! You need ${formatPrice(totalPrice)} but only have ${formatPrice(wallet.balance)}. Please add funds.`
        );
      }

      if (totalPrice <= 0) {
        throw new Error('Invalid order total. Please select engagement types.');
      }

      // Prevent non-2xx failures from provider min-quantity rules
      const belowMin = Object.entries(engagements)
        .filter(([_, config]) => config.enabled)
        .filter(([_, config]) => (config.minQuantity ?? 0) > 0)
        .filter(([_, config]) => config.quantity < (config.minQuantity ?? 0))
        .map(([type, config]) => ({
          type,
          quantity: config.quantity,
          min: config.minQuantity as number,
        }));

      if (belowMin.length > 0) {
        const first = belowMin[0];
        throw new Error(
          `${first.type} quantity ${first.quantity} is below minimum ${first.min}. Increase Base Quantity or edit that type.`
        );
      }

      const bundle = bundles?.[0];

      // Call edge function to process engagement order with per-type organic settings
      const { data, error } = await supabase.functions.invoke('process-engagement-order', {
        body: {
          user_id: user.id,
          bundle_id: bundle?.id,
          link: link.trim(),
          base_quantity: baseQuantity,
          total_price: totalPrice,
          is_organic_mode: isOrganicMode,
          // Per-type settings will be in each engagement object
          engagements: Object.entries(engagements)
            .filter(([_, config]) => config.enabled)
            .map(([type, config]) => {
              // CRITICAL: Resolve time limit - if -1 (custom), the actual value should be stored
              // The EngagementTypeCard should store actual hours, but if it sends -1, treat as Auto (0)
              let effectiveTimeLimit = config.timeLimitHours;
              if (effectiveTimeLimit === -1) {
                // -1 means "Custom" was selected but no value stored - treat as Auto
                effectiveTimeLimit = 0;
              }

              const scheduledRuns = previewSchedules[type]?.map((run, index) => ({
                ...run,
                run_number: index + 1,
              }));

              return {
                type,
                quantity: config.quantity,
                price: config.price,
                service_id: config.serviceId,
                // Per-type organic settings - always send resolved hours value
                time_limit_hours: effectiveTimeLimit,
                variance_percent: config.variancePercent,
                peak_hours_enabled: config.peakHoursEnabled,
                scheduled_runs: scheduledRuns,
              };
            }),
        },
      });

      if (error) {
        // Supabase often returns a generic message ("non-2xx") — try to extract the real server error
        let message = (error as any)?.message || 'Order failed';
        const ctx = (error as any)?.context;
        if (ctx && typeof ctx.text === 'function') {
          try {
            const text = await ctx.text();
            if (text) {
              try {
                const parsed = JSON.parse(text);
                message = parsed?.error || parsed?.message || text;
              } catch {
                message = text;
              }
            }
          } catch {
            // ignore
          }
        }
        throw new Error(message);
      }

      if ((data as any)?.error) throw new Error((data as any).error);
      return data;
    },
    onSuccess: (data) => {
      toast({
        title: "🚀 Order Placed!",
        description: `Order #${data.order_number} created. ${formatPrice(totalPrice)} deducted.`,
      });
      // Immediately refresh wallet from auth context
      refreshWallet();
      queryClient.invalidateQueries({ queryKey: ['engagement-orders'] });
      navigate('/engagement-orders');
    },
    onError: (error: Error) => {
      toast({
        title: "Order Failed",
        description: error.message,
        variant: "destructive",
      });
      // Refresh wallet to show updated balance
      refreshWallet();
    },
  });

  // INSTANT RENDER - No loading state blocking UI
  // Redirect happens via useEffect in DashboardLayout if not authenticated

  if (!user && !authLoading) {
    navigate('/auth');
    return null;
  }

  // Check if user can afford the order
  const canAfford = wallet && wallet.balance > 0 && wallet.balance >= totalPrice;

  // Detect platform from link for validation
  const detectPlatformFromLink = (url: string): string | null => {
    const lower = url.toLowerCase();
    if (lower.includes('instagram.com') || lower.includes('instagr.am')) return 'instagram';
    if (lower.includes('youtube.com') || lower.includes('youtu.be')) return 'youtube';
    if (lower.includes('tiktok.com')) return 'tiktok';
    if (lower.includes('twitter.com') || lower.includes('x.com')) return 'twitter';
    if (lower.includes('facebook.com') || lower.includes('fb.com')) return 'facebook';
    return null;
  };

  // Handle order button click - SUBSCRIPTION FIRST, then BALANCE
  const handlePlaceOrder = () => {
    // Wait for bundles to load
    if (bundlesLoading) {
      toast({
        title: "Loading...",
        description: "Please wait while services load.",
      });
      return;
    }

    // Basic validation first
    if (!link.trim()) {
      toast({
        title: "Link Required",
        description: "Please enter a valid link.",
        variant: "destructive",
      });
      return;
    }

    // NEW: Detect platform from link and validate it matches selected platform
    const detectedPlatform = detectPlatformFromLink(link);
    if (detectedPlatform && detectedPlatform !== platform) {
      toast({
        title: "⚠️ Platform Mismatch",
        description: `You selected ${platform.toUpperCase()}, but the link is for ${detectedPlatform.toUpperCase()}. Please select the correct platform.`,
        variant: "destructive",
      });
      return;
    }

    // NEW: Check if the selected platform has services configured
    if (activeEngagementTypes.length === 0) {
      toast({
        title: "❌ Services Not Available",
        description: `No services are configured for ${platform.toUpperCase()} yet. Please contact Admin.`,
        variant: "destructive",
      });
      return;
    }

    // NEW: Double check that all enabled engagements have service IDs
    const missingServiceEngagements = Object.entries(engagements)
      .filter(([_, config]) => config.enabled && !config.serviceId)
      .map(([type]) => type);

    if (missingServiceEngagements.length > 0) {
      toast({
        title: "❌ Service Configuration Error",
        description: `${missingServiceEngagements.join(', ')} services are not configured. This order cannot be sent to provider.`,
        variant: "destructive",
      });
      return;
    }

    // NEW: Block orders where any enabled engagement type has zero price
    const zeroPriceEngagements = Object.entries(engagements)
      .filter(([_, config]) => config.enabled && config.price <= 0)
      .map(([type]) => type);

    if (zeroPriceEngagements.length > 0) {
      toast({
        title: "⚠️ Pricing Error",
        description: `${zeroPriceEngagements.join(', ')} has $0.00 price. Service pricing may not be configured correctly. Please contact support.`,
        variant: "destructive",
      });
      return;
    }

    // Admin gets free access - no subscription or balance required
    if (isAdmin) {
      placeOrderMutation.mutate();
      return;
    }





    // STEP 2: After subscription is confirmed, check balance
    if (!wallet || wallet.balance <= 0) {
      toast({
        title: "🚫 No Balance",
        description: "Your account has no balance. Please add funds first!",
        variant: "destructive",
      });
      navigate('/wallet');
      return;
    }

    if (!canAfford) {
      toast({
        title: "💰 Insufficient Balance",
        description: `Your wallet has ${formatPrice(wallet?.balance || 0)}. This order requires ${formatPrice(totalPrice)}. Please add funds!`,
        variant: "destructive",
      });
      navigate('/wallet');
      return;
    }

    placeOrderMutation.mutate();
  };

  return (
    <DashboardLayout>
      <div className="max-w-5xl mx-auto px-2 sm:px-6 lg:px-8 space-y-3 sm:space-y-6 pb-8">
        {/* Mission Console — unique compact hero with inline AI controls */}
        <div className="relative overflow-hidden rounded-2xl border border-border bg-[#ffffff]/80 backdrop-blur-xl">
          {/* Aurora wash */}
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-80">
            <div className="absolute -top-24 -left-16 w-[360px] h-[360px] bg-primary/25 blur-[120px] rounded-full" />
            <div className="absolute -bottom-24 -right-10 w-[320px] h-[320px] bg-primary/20 blur-[120px] rounded-full" />
            <div className="absolute top-1/3 left-1/2 w-[260px] h-[260px] bg-emerald-500/10 blur-[120px] rounded-full" />
          </div>
          {/* Grid texture */}
          <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{
            backgroundImage: 'linear-gradient(#a78bfa 1px, transparent 1px), linear-gradient(90deg, #a78bfa 1px, transparent 1px)',
            backgroundSize: '28px 28px',
            maskImage: 'radial-gradient(ellipse at center, black 50%, transparent 85%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 50%, transparent 85%)',
          }} />

          <div className="relative z-10 p-4 sm:p-6">
            {/* Top row: status + title + live dot */}
            <div className="flex items-start justify-between gap-3 mb-4 sm:mb-5">
              <div className="min-w-0">
                <div className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full bg-card border border-border mb-2.5">
                  <span className="relative flex w-1.5 h-1.5">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                    <span className="relative inline-flex w-1.5 h-1.5 rounded-full bg-emerald-400" />
                  </span>
                  <span className="text-[10px] font-semibold tracking-[0.18em] uppercase !text-foreground/70">Engagement Console</span>
                </div>
                <h1 className="text-xl sm:text-3xl font-bold tracking-tight !text-foreground leading-tight">
                  Organic <span className="italic font-serif text-transparent bg-clip-text bg-gradient-to-r from-primary via-primary to-emerald-300">Full Engagement</span>
                </h1>
                <p className="text-[12px] sm:text-[13px] text-muted-foreground mt-1 max-w-md">
                  One link — every engagement type, dispatched with humanlike organic pacing.
                </p>
              </div>
              <div className="hidden sm:flex shrink-0 w-12 h-12 rounded-xl items-center justify-center bg-gradient-to-br from-primary/30 to-primary/20 border border-border shadow-[0_0_30px_rgba(168,85,247,0.25)]">
                <Rocket className="h-5 w-5 text-primary" />
              </div>
            </div>

            {/* Inline AI Modules — segmented control style */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
              {/* Organic Algorithm */}
              <button
                type="button"
                onClick={() => { setIsOrganicMode(!isOrganicMode); if (!isOrganicMode) setIsAutoRatios(false); }}
                className={cn(
                  "group relative text-left rounded-xl border p-3 sm:p-3.5 transition-all overflow-hidden",
                  isOrganicMode
                    ? "border-emerald-400/40 bg-emerald-500/[0.08] shadow-[0_0_25px_rgba(16,185,129,0.18)]"
                    : "border-border bg-card hover:border-border hover:bg-card"
                )}
              >
                {isOrganicMode && (
                  <div aria-hidden className="absolute -top-8 -right-8 w-32 h-32 bg-emerald-400/20 blur-3xl rounded-full" />
                )}
                <div className="relative flex items-center gap-3">
                  <div className={cn(
                    "shrink-0 w-9 h-9 rounded-lg flex items-center justify-center border transition-all",
                    isOrganicMode ? "bg-emerald-500/20 border-emerald-400/40 text-emerald-200" : "bg-card border-border text-muted-foreground"
                  )}>
                    <Brain className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[12px] sm:text-[13px] font-bold !text-foreground tracking-tight">AI Organic Algorithm</span>
                      <span className={cn(
                        "text-[9px] font-bold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-md border",
                        isOrganicMode ? "bg-emerald-500/15 text-emerald-200 border-emerald-400/30" : "bg-card text-muted-foreground border-border"
                      )}>
                        {isOrganicMode ? "Active" : "Idle"}
                      </span>
                    </div>
                    <p className="text-[10.5px] sm:text-[11px] text-muted-foreground leading-snug">
                      Unique S-curve · Random variance · Anti-bot
                    </p>
                  </div>
                  <div className={cn(
                    "shrink-0 w-9 h-5 rounded-full p-0.5 transition-all relative",
                    isOrganicMode ? "bg-emerald-500/80" : "bg-card"
                  )}>
                    <div className={cn(
                      "w-4 h-4 rounded-full bg-white shadow transition-all",
                      isOrganicMode ? "translate-x-4" : "translate-x-0"
                    )} />
                  </div>
                </div>
              </button>

              {/* Smart Ratios */}
              <button
                type="button"
                onClick={() => { setIsAutoRatios(!isAutoRatios); if (!isAutoRatios) setIsOrganicMode(false); }}
                className={cn(
                  "group relative text-left rounded-xl border p-3 sm:p-3.5 transition-all overflow-hidden",
                  isAutoRatios
                    ? "border-primary/40 bg-primary/[0.08] shadow-[0_0_25px_rgba(168,85,247,0.18)]"
                    : "border-border bg-card hover:border-border hover:bg-card"
                )}
              >
                {isAutoRatios && (
                  <div aria-hidden className="absolute -top-8 -right-8 w-32 h-32 bg-primary/25 blur-3xl rounded-full" />
                )}
                <div className="relative flex items-center gap-3">
                  <div className={cn(
                    "shrink-0 w-9 h-9 rounded-lg flex items-center justify-center border transition-all",
                    isAutoRatios ? "bg-primary/20 border-primary/40 text-primary" : "bg-card border-border text-muted-foreground"
                  )}>
                    <Percent className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <span className="text-[12px] sm:text-[13px] font-bold !text-foreground tracking-tight">AI Smart Ratios</span>
                      <span className={cn(
                        "text-[9px] font-bold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-md border",
                        isAutoRatios ? "bg-primary/15 text-primary border-primary/30" : "bg-card text-muted-foreground border-border"
                      )}>
                        {isAutoRatios ? "Auto" : "Manual"}
                      </span>
                    </div>
                    <p className="text-[10.5px] sm:text-[11px] text-muted-foreground leading-snug italic">
                      {isAutoRatios ? "Optimized for platform algorithms" : "You set the engagement mix"}
                    </p>
                  </div>
                  <div className={cn(
                    "shrink-0 w-9 h-5 rounded-full p-0.5 transition-all",
                    isAutoRatios ? "bg-primary/80" : "bg-card"
                  )}>
                    <div className={cn(
                      "w-4 h-4 rounded-full bg-white shadow transition-all",
                      isAutoRatios ? "translate-x-4" : "translate-x-0"
                    )} />
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>


        {/* Platform Selector */}
        <Card className="glass-card border-2 border-border">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center gap-2 sm:gap-3 mb-4 sm:mb-5">
              <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-foreground/10 flex items-center justify-center">
                <Rocket className="h-4 w-4 sm:h-5 sm:w-5 text-foreground" />
              </div>
              <Label className="text-base sm:text-lg font-bold tracking-tight text-foreground">Select Platform</Label>
            </div>
            <PlatformSelector
              selected={platform}
              onSelect={setPlatform}
              availablePlatforms={availablePlatforms}
            />
          </CardContent>
        </Card>

        {/* Link Input */}
        <Card className="glass-card border-2 border-border">
          <CardContent className="p-4 sm:p-6">
            <div className="flex items-center justify-between gap-2 sm:gap-3 mb-4 sm:mb-5">
              <div className="flex items-center gap-2 sm:gap-3 min-w-0">
                <div className="w-8 h-8 sm:w-10 sm:h-10 rounded-xl bg-foreground/10 flex items-center justify-center shrink-0">
                  <LinkIcon className="h-4 w-4 sm:h-5 sm:w-5 text-foreground" />
                </div>
                <Label className="text-base sm:text-lg font-bold tracking-tight text-foreground truncate">Video/Post Link</Label>
              </div>
              <AIEngagementChat
                link={link}
                platform={platform}
                engagements={engagements}
                totalQuantity={baseQuantity}
              />
            </div>
            <Input
              placeholder={`https://${platform}.com/...`}
              value={link}
              onChange={(e) => setLink(e.target.value)}
              className="h-12 sm:h-14 text-base sm:text-lg rounded-xl border-2 border-border focus:border-foreground bg-secondary text-foreground font-medium placeholder:text-muted-foreground transition-all"
            />
          </CardContent>
        </Card>

        {/* Base Quantity */}
        <Card className="glass-card border-2 border-border">
          <CardContent className="p-4 sm:p-6">
            <QuantitySelector
              value={baseQuantity}
              onChange={setBaseQuantity}
              min={100}
              max={1000000}
            />
          </CardContent>
        </Card>

        {/* Engagement Types with Per-Type Settings */}
        <div className="space-y-4 sm:space-y-5">
          <div className="flex items-center justify-between px-1 gap-2">
            <div className="min-w-0">
              <h2 className="text-lg sm:text-xl font-bold tracking-tight text-foreground">Engagement Breakdown</h2>
              <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1 hidden sm:block">
                Customize organic settings per type
              </p>
            </div>
            <span className="text-xs sm:text-sm bg-foreground text-background px-3 sm:px-4 py-1.5 sm:py-2 rounded-xl font-bold shrink-0">
              {bundlesLoading ? (
                <span className="flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading...</span>
              ) : (
                `${Object.values(engagements).filter(e => e.enabled).length} active`
              )}
            </span>
          </div>
          <div className="grid gap-3 sm:gap-4">
            {activeEngagementTypes.map(type => (
              engagements[type] && (
                <EngagementTypeCard
                  key={type}
                  type={type}
                  config={engagements[type]}
                  baseQuantity={baseQuantity}
                  onChange={(config) => handleEngagementChange(type, config)}
                  minQuantity={engagements[type]?.minQuantity}
                  customCurvePoints={drawModeState.isEnabled ? drawModeState.points[type] : undefined}
                  pricePerK={servicePrices[type]?.pricePerK}
                />
              )
            ))}
          </div>
        </div>

        {/* Drawable Growth Chart - Interactive curve editing */}
        {activeEngagementTypes.length > 0 && (
          <DrawableGrowthChart
            engagements={engagements as Record<EngagementType, EngagementConfig>}
            onCurveChange={handleCurveChange}
            drawModeState={drawModeState}
            onDrawModeChange={setDrawModeState}
          />
        )}

        {/* Heavy delivery previews — opt-in to keep initial render snappy */}
        {activeEngagementTypes.length > 0 && (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setShowPreview((v) => !v)}
              className="rounded-full"
            >
              {showPreview ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
              {showPreview ? 'Hide delivery preview' : 'Show delivery preview'}
            </Button>
          </div>
        )}

        {showPreview && !drawModeState.isEnabled && activeEngagementTypes.length > 0 && (
          <Suspense fallback={<div className="text-center text-xs text-muted-foreground py-4">Loading chart…</div>}>
            <LiveGrowthChart
              engagements={engagements as Record<EngagementType, EngagementConfig>}
              refreshKey={previewRefreshKey}
              onRefresh={() => setPreviewRefreshKey(k => k + 1)}
              platform={platform as 'instagram' | 'tiktok' | 'youtube' | 'twitter' | 'facebook'}
            />
          </Suspense>
        )}

        {showPreview && activeEngagementTypes.length > 0 && (
          <Suspense fallback={<div className="text-center text-xs text-muted-foreground py-4">Loading timeline…</div>}>
            <DeliveryPreview
              engagements={engagements as Record<EngagementType, EngagementConfig>}
              refreshKey={previewRefreshKey}
              platform={platform as 'instagram' | 'tiktok' | 'youtube' | 'twitter' | 'facebook'}
              customCurvePoints={drawModeState.isEnabled ? drawModeState.points : undefined}
              onScheduleChange={handleScheduleChange}
            />
          </Suspense>
        )}

        {/* Organic engagement ratio / botting % warning */}
        <PreOrderRatioWarning engagements={engagements as any} />

        {/* Order Summary - Compact on mobile */}
        <Card className="glass-card border-2 border-primary/40 bg-gradient-to-br from-primary/5 via-transparent to-primary/10 overflow-hidden">
          <CardContent className="p-4 sm:p-6">
            <div className="flex flex-col gap-4 sm:gap-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1 sm:space-y-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl sm:text-3xl lg:text-4xl font-bold text-primary">{formatPrice(totalPrice)}</span>
                  <span className="text-muted-foreground text-xs sm:text-sm">total</span>
                </div>
                <p className="text-xs sm:text-sm text-muted-foreground">
                  {totalEngagements.toLocaleString()} engagements • {Object.values(engagements).filter(e => e.enabled).length} types
                </p>
              </div>

              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-4">
                <div className="text-left sm:text-right p-2.5 sm:p-3 rounded-xl bg-secondary/50">
                  <div className="flex items-center gap-2 text-xs sm:text-sm font-medium">
                    <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4 text-muted-foreground" />
                    <span>Balance: {formatPrice(wallet?.balance || 0)}</span>
                  </div>
                  {!canAfford && totalPrice > 0 && (
                    <p className="text-[10px] sm:text-xs text-destructive mt-1">
                      Insufficient balance
                    </p>
                  )}
                </div>

                <Button
                  size="lg"
                  onClick={handlePlaceOrder}
                  disabled={!link.trim() || placeOrderMutation.isPending || bundlesLoading}
                  className="h-12 sm:h-14 px-6 sm:px-8 text-base sm:text-lg font-bold rounded-xl bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 shadow-lg shadow-primary/25 transition-all duration-300"
                >
                  {placeOrderMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 sm:h-5 sm:w-5 animate-spin mr-2" />
                      Processing...
                    </>
                  ) : bundlesLoading ? (
                    <>
                      <Loader2 className="h-4 w-4 sm:h-5 sm:w-5 animate-spin mr-2" />
                      Loading...
                    </>
                  ) : (
                    <>
                      <Rocket className="h-4 w-4 sm:h-5 sm:w-5 mr-2" />
                      Place Order — {formatPrice(totalPrice)}
                    </>
                  )}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

    </DashboardLayout>
  );
}
