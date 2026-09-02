import { useMemo, useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { 
  EngagementConfig, 
  EngagementType, 
  ENGAGEMENT_CONFIG,
  DEFAULT_ORGANIC_SETTINGS
} from "@/lib/engagement-types";
import { 
  generateOrganicSchedule,
  formatDuration,
  FullOrganicConfig,
  PROVIDER_MINIMUMS
} from "@/lib/organic-algorithm";
import { 
  ControlPoint, 
  curveToSchedule, 
  interpolateCurve 
} from "@/lib/curve-to-schedule";
import { Clock, TrendingUp, Zap, Timer, Calendar } from "lucide-react";

type Platform = 'instagram' | 'tiktok' | 'youtube' | 'twitter' | 'facebook';

interface DeliveryPreviewProps {
  engagements: Record<EngagementType, EngagementConfig>;
  refreshKey?: number;
  platform?: Platform;
  customCurvePoints?: Record<EngagementType, ControlPoint[]>;
  onScheduleChange?: (payload: {
    schedules: FullOrganicConfig[];
    customQuantities: Record<string, number>;
  }) => void;
}

export function DeliveryPreview({ engagements, refreshKey = 0, platform = 'instagram', customCurvePoints, onScheduleChange }: DeliveryPreviewProps) {
  const [customQuantities, setCustomQuantities] = useState<Record<string, number>>({});

  // Reset custom quantities when engagements, refreshKey, or curve changes
  useEffect(() => {
    setCustomQuantities({});
  }, [engagements, refreshKey, customCurvePoints]);

  const { schedules, stats, perTypeStats } = useMemo(() => {
    // Include refreshKey in the computation to trigger regeneration
    const _ = refreshKey;
    const enabledTypes = Object.entries(engagements)
      .filter(([_, config]) => config.enabled && config.quantity > 0)
      .map(([type, config]) => ({
        type: type as EngagementType,
        config,
      }));

    if (enabledTypes.length === 0) {
      return { schedules: [], stats: null, perTypeStats: [] };
    }

    const baseStartTime = new Date();
    
    // DELIVERY SEQUENCING: Views first, then other types with realistic delays
    // Priority order: Views (0) → Likes → Comments → Saves → Shares → others
    const TYPE_PRIORITY: Partial<Record<EngagementType, number>> = {
      views: 0,
      likes: 1,
      comments: 2,
      saves: 3,
      shares: 4,
      followers: 5,
      subscribers: 6,
      watch_hours: 7,
      retweets: 4,
      reposts: 5,
    };
    
    // Delay offsets from Views start (in minutes) - randomized for organic feel
    const TYPE_DELAY_FROM_VIEWS: Partial<Record<EngagementType, { min: number; max: number }>> = {
      views: { min: 0, max: 0 },           // Views start immediately
      likes: { min: 15, max: 45 },         // Likes: 15-45 min after views
      comments: { min: 30, max: 90 },      // Comments: 30-90 min after views
      saves: { min: 45, max: 120 },        // Saves: 45-120 min after views
      shares: { min: 35, max: 100 },       // Shares: 35-100 min after views
      followers: { min: 60, max: 150 },    // Followers: 60-150 min after views
      subscribers: { min: 50, max: 130 },  // Subscribers: 50-130 min after views
      watch_hours: { min: 20, max: 60 },   // Watch hours: 20-60 min after views
      retweets: { min: 25, max: 80 },      // Retweets: 25-80 min after views
      reposts: { min: 30, max: 90 },       // Reposts: 30-90 min after views
    };
    
    // Sort by priority so views are processed first
    const sortedTypes = [...enabledTypes].sort((a, b) => 
      (TYPE_PRIORITY[a.type] ?? 10) - (TYPE_PRIORITY[b.type] ?? 10)
    );
    
    // Track when views actually start/end so other engagement types can follow the same window
    let viewsStartTime = baseStartTime;
    let viewsDurationHours = 0;
    
    // Generate individual schedule for each type with SEQUENCED start times
    const schedules: FullOrganicConfig[] = sortedTypes.map(({ type, config }) => {
      const rawTimeLimitHours = config.timeLimitHours ?? DEFAULT_ORGANIC_SETTINGS.timeLimitHours;
      const variancePercent = config.variancePercent ?? DEFAULT_ORGANIC_SETTINGS.variancePercent;
      const peakHoursEnabled = config.peakHoursEnabled ?? DEFAULT_ORGANIC_SETTINGS.peakHoursEnabled;
      const serviceMinimum = config.minQuantity || PROVIDER_MINIMUMS[type] || 10;
      // Each type uses its OWN time limit (user's per-type setting wins)
      const timeLimitHours = rawTimeLimitHours;
      
      // Calculate start time based on type priority and views anchor
      let typeStartTime: Date;
      if (type === 'views') {
        typeStartTime = baseStartTime;
      } else {
        // Anchor to views start + random delay offset
        const delayConfig = TYPE_DELAY_FROM_VIEWS[type] ?? { min: 30, max: 90 };
        const delayMinutes = delayConfig.min + Math.random() * (delayConfig.max - delayConfig.min);
        typeStartTime = new Date(viewsStartTime.getTime() + delayMinutes * 60 * 1000);
      }
      
      // Check if we have custom curve points for this type
      const curvePoints = customCurvePoints?.[type];
      
      if (curvePoints && curvePoints.length >= 2) {
        // Use custom curve to generate schedule
        const totalDurationHours = timeLimitHours > 0 ? timeLimitHours : 24;
        const curveRuns = curveToSchedule(
          curvePoints,
          type,
          config.quantity,
          totalDurationHours,
          Math.min(30, Math.max(5, Math.ceil(config.quantity / serviceMinimum)))
        );
        
        // Convert curve runs to schedule format with full OrganicRunConfig properties
        const runs = curveRuns.map((run, idx) => {
          const timeOffset = (run.timePercent / 100) * totalDurationHours * 60 * 60 * 1000;
          const runTime = new Date(typeStartTime.getTime() + timeOffset);
          return {
            scheduledAt: runTime,
            quantity: run.quantity,
            runNumber: run.runNumber,
            baseQuantity: run.quantity,
            varianceApplied: 0,
            peakMultiplier: 1,
            dayOfWeek: runTime.getDay(),
            hourOfDay: runTime.getHours(),
            sessionType: 'normal' as const,
            humanBehaviorScore: 85,
            patternBreaker: false,
          };
        });
        
        const totalDuration = runs.length > 1 
          ? runs[runs.length - 1].scheduledAt.getTime() - runs[0].scheduledAt.getTime()
          : 0;
        
        return {
          engagementType: type,
          runs,
          totalDuration,
          totalQuantity: config.quantity,
          runCount: runs.length,
          warnings: [] as string[],
          patternBreakCount: 0,
          avgHumanScore: 85,
          varietyIndex: 0.8,
        } as FullOrganicConfig;
      }
      
      // Default: use organic schedule generator
      const maxRunsByMin = Math.max(1, Math.floor(config.quantity / serviceMinimum));
      const requestedRuns = config.customRunCount && config.customRunCount > 0
        ? Math.min(config.customRunCount, maxRunsByMin)
        : undefined;
      const schedule = generateOrganicSchedule(
        type,
        config.quantity,
        variancePercent,
        peakHoursEnabled,
        typeStartTime,
        serviceMinimum,
        timeLimitHours > 0 ? timeLimitHours : undefined,
        requestedRuns
      );
      
      // Capture views first run time for anchoring other types
      if (type === 'views' && schedule.runs.length > 0) {
        viewsStartTime = schedule.runs[0].scheduledAt;
        const lastViewRun = schedule.runs[schedule.runs.length - 1];
        viewsDurationHours = Math.max(
          (lastViewRun.scheduledAt.getTime() - schedule.runs[0].scheduledAt.getTime()) / (1000 * 60 * 60),
          0.25
        );
      }
      
      return schedule;
    });

    // Calculate stats
    const totalRuns = schedules.reduce((sum, s) => sum + s.runs.length, 0);
    const maxDuration = Math.max(...schedules.map(s => s.totalDuration));
    const totalEngagements = schedules.reduce((sum, s) => sum + s.runs.reduce((rs, r) => rs + r.quantity, 0), 0);

    // Per-type stats for summary
    const perTypeStats = schedules.map(schedule => {
      const config = engagements[schedule.engagementType as EngagementType];
      const finishTime = schedule.runs.length > 0 
        ? schedule.runs[schedule.runs.length - 1].scheduledAt 
        : baseStartTime;
      
      const typeTotal = schedule.runs.reduce((sum, r) => sum + r.quantity, 0);

      return {
        type: schedule.engagementType as EngagementType,
        runs: schedule.runs.length,
        duration: schedule.totalDuration,
        finishTime,
        timeLimitHours: config.timeLimitHours ?? 0,
        variancePercent: config.variancePercent ?? 25,
        peakHoursEnabled: config.peakHoursEnabled ?? false, // OFF by default
        totalQuantity: typeTotal,
      };
    });

    return {
      schedules,
      stats: {
        totalRuns,
        totalDuration: maxDuration,
        totalEngagements,
        typesActive: enabledTypes.length,
      },
      perTypeStats,
    };
  }, [engagements, customQuantities, refreshKey, customCurvePoints]);

  useEffect(() => {
    onScheduleChange?.({ schedules, customQuantities });
  }, [schedules, customQuantities, onScheduleChange]);

  if (!stats) {
    return null;
  }

  return (
    <Card className="border border-border bg-background">
      <CardHeader className="pb-3 px-3 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg text-foreground">
          <TrendingUp className="h-4 w-4 sm:h-5 sm:w-5 text-foreground shrink-0" />
          <span className="truncate">🌱 Per-Type Organic Delivery Preview</span>
        </CardTitle>
        <p className="text-xs sm:text-sm text-muted-foreground">
          Each type has its own organic settings
        </p>
        <div className="flex flex-wrap gap-1.5 sm:gap-2 mt-2">
          <Badge className="flex items-center gap-1 bg-foreground text-background font-bold text-xs">
            <Zap className="h-3 w-3" />
            {stats?.totalEngagements.toLocaleString()}
          </Badge>
          <Badge variant="outline" className="flex items-center gap-1 border-border text-foreground text-xs">
            <Timer className="h-3 w-3" />
            {stats?.totalRuns} runs
          </Badge>
          <Badge variant="outline" className="flex items-center gap-1 border-border text-foreground text-xs">
            <Clock className="h-3 w-3" />
            ~{formatDuration(stats?.totalDuration || 0)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="p-3 sm:p-6">
        {/* Per-type breakdown - Compact on mobile */}
        <div className="grid grid-cols-5 gap-1 sm:gap-2 mb-4">
          {perTypeStats.map(stat => {
            const config = ENGAGEMENT_CONFIG[stat.type];
            return (
              <div 
                key={stat.type}
                className="bg-secondary rounded-lg p-1.5 sm:p-2 text-center border border-border"
              >
                <span className="text-sm sm:text-lg">{config?.emoji}</span>
                <p className="text-[10px] sm:text-xs font-bold text-foreground">{stat.runs}</p>
                <p className="text-[8px] sm:text-[10px] text-muted-foreground hidden sm:block">
                  {stat.timeLimitHours > 0 ? `${stat.timeLimitHours}h` : 'Auto'}
                </p>
              </div>
            );
          })}
        </div>

        {/* Settings summary per type - hidden on mobile */}
        <div className="mb-4 p-3 bg-secondary rounded-lg border border-border hidden sm:block">
          <p className="text-xs font-bold text-foreground mb-2 flex items-center gap-1">
            <Calendar className="h-3 w-3" />
            Per-Type Settings
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
            {perTypeStats.map(stat => {
              const config = ENGAGEMENT_CONFIG[stat.type];
              return (
                <div key={stat.type} className="text-xs flex items-center gap-2">
                  <span>{config?.emoji}</span>
                  <span className="font-bold text-foreground">{config?.label}:</span>
                  <span className="text-muted-foreground">
                    {stat.timeLimitHours > 0 ? `${stat.timeLimitHours}h` : 'Auto'} 
                    {' · '}±{stat.variancePercent}%
                    {stat.peakHoursEnabled && ' · 🔥'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

      </CardContent>
    </Card>
  );
}
