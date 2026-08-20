// Central React Query key namespace for Instagram-related caches.
// Bumping this prefix invalidates any stale frontend cache after scraper/API changes.
export const IG_CACHE_PREFIX = 'ig_cache_v2' as const;

export const igQueryKeys = {
  accounts: (userId?: string) => [IG_CACHE_PREFIX, 'accounts', userId] as const,
  linkEvents: (userId?: string) => [IG_CACHE_PREFIX, 'link-events', userId] as const,
  postsSummary: (userId?: string, accountId?: string | null) =>
    [IG_CACHE_PREFIX, 'posts-summary', userId, accountId] as const,
};
