import { useCallback } from 'react';

/**
 * Global markup has been removed. Admin sets each service's per-1000 price directly
 * in /admin/services — that price is now the final price everywhere.
 *
 * This hook is kept as a no-op identity shim so existing call sites keep compiling
 * without behavioural change.
 */
export function useGlobalMarkup() {
  const applyMarkup = useCallback((basePrice: number): number => basePrice, []);
  return { markupPercent: 0, applyMarkup, isLoading: false };
}
