import { useAuth } from '@/hooks/useAuth';

/**
 * Optimized: Returns the wallet from AuthContext which already handles
 * realtime updates and initial fetch, avoiding redundant Supabase queries.
 */
export function useWallet() {
  const { wallet, isLoading } = useAuth();
  return { wallet, isLoading, error: null };
}
