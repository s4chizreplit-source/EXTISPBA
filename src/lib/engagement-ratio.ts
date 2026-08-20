// Instagram / generic short-video organic engagement benchmarks.
// Ratios are relative to VIEWS (or to followers if views == 0).
// Sources: industry averages (Hootsuite, Later, SocialInsider 2024).

export type RatioKey = "likes" | "comments" | "shares" | "saves";

export interface Band {
  /** % of views considered organically healthy */
  lowOk: number;
  highOk: number;
  /** Outside this hard danger band → ratio looks clearly botted */
  lowDanger: number;
  highDanger: number;
  label: string;
}

export const RATIO_BANDS: Record<RatioKey, Band> = {
  likes:    { lowOk: 4,   highOk: 10,  lowDanger: 1,   highDanger: 20, label: "Likes / Views" },
  comments: { lowOk: 0.3, highOk: 1.5, lowDanger: 0.05, highDanger: 4, label: "Comments / Views" },
  shares:   { lowOk: 0.3, highOk: 2,   lowDanger: 0.02, highDanger: 5, label: "Shares / Views" },
  saves:    { lowOk: 0.3, highOk: 3,   lowDanger: 0.02, highDanger: 6, label: "Saves / Views" },
};

export interface Counts {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
  saves?: number;
}

export interface RatioCheck {
  key: RatioKey;
  label: string;
  value: number;        // raw count
  ratioPct: number;     // % of views
  band: Band;
  status: "ok" | "low" | "high" | "danger_low" | "danger_high" | "none";
  score: number;        // 0-100 healthiness for this ratio
  message: string;
}

/** Linear-falloff score: 100 inside ok band, 0 at danger edges. */
function scoreRatio(pct: number, band: Band): number {
  if (pct >= band.lowOk && pct <= band.highOk) return 100;
  if (pct < band.lowOk) {
    if (pct <= band.lowDanger) return 0;
    return Math.round(((pct - band.lowDanger) / (band.lowOk - band.lowDanger)) * 100);
  }
  if (pct >= band.highDanger) return 0;
  return Math.round(((band.highDanger - pct) / (band.highDanger - band.highOk)) * 100);
}

export function checkRatio(key: RatioKey, count: number, views: number): RatioCheck {
  const band = RATIO_BANDS[key];
  if (!views || views <= 0) {
    return {
      key, label: band.label, value: count, ratioPct: 0, band,
      status: "none", score: 100,
      message: "No views ordered — ratio cannot be measured.",
    };
  }
  const pct = (count / views) * 100;
  let status: RatioCheck["status"] = "ok";
  if (pct <= band.lowDanger) status = "danger_low";
  else if (pct < band.lowOk) status = "low";
  else if (pct >= band.highDanger) status = "danger_high";
  else if (pct > band.highOk) status = "high";

  const score = scoreRatio(pct, band);

  const msgs: Record<RatioCheck["status"], string> = {
    ok: `Healthy organic range (${band.lowOk}–${band.highOk}%).`,
    low: `A bit low for organic reach. Target ${band.lowOk}–${band.highOk}%.`,
    high: `Higher than typical organic. Target ${band.lowOk}–${band.highOk}%.`,
    danger_low: `Too few ${key} for these views — Instagram may flag the post as bot-driven.`,
    danger_high: `Too many ${key} vs views — looks artificially boosted.`,
    none: "No views in order.",
  };

  return { key, label: band.label, value: count, ratioPct: pct, band, status, score, message: msgs[status] };
}

export interface RatioReport {
  views: number;
  checks: RatioCheck[];
  /** 0-100 overall organic health */
  healthScore: number;
  /** Inverse: 0 = clean, 100 = clearly botted */
  bottingPct: number;
  suggestions: string[];
}

export function analyzeCounts(counts: Counts): RatioReport {
  const views = counts.views ?? 0;
  const keys: RatioKey[] = ["likes", "comments", "shares", "saves"];
  const checks = keys
    .filter((k) => (counts[k] ?? 0) > 0 || views > 0)
    .map((k) => checkRatio(k, counts[k] ?? 0, views));

  const measurable = checks.filter((c) => c.status !== "none");
  const healthScore = measurable.length
    ? Math.round(measurable.reduce((s, c) => s + c.score, 0) / measurable.length)
    : 100;
  const bottingPct = 100 - healthScore;

  const suggestions: string[] = [];
  for (const c of checks) {
    if (c.status === "low" || c.status === "danger_low") {
      const ideal = Math.round((c.band.lowOk + c.band.highOk) / 2);
      const target = Math.round((views * ideal) / 100);
      suggestions.push(
        `Add more ${c.key}: currently ${c.value.toLocaleString()} (${c.ratioPct.toFixed(2)}%). Try ~${target.toLocaleString()} (${ideal}%).`
      );
    } else if (c.status === "high" || c.status === "danger_high") {
      const ideal = Math.round((c.band.lowOk + c.band.highOk) / 2);
      const target = Math.round((views * ideal) / 100);
      suggestions.push(
        `Reduce ${c.key} or add more views: currently ${c.value.toLocaleString()} (${c.ratioPct.toFixed(2)}%). Aim ~${target.toLocaleString()} (${ideal}%).`
      );
    }
  }

  return { views, checks, healthScore, bottingPct, suggestions };
}
