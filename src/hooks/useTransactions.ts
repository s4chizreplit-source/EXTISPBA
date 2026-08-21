import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';

export type TransactionFilter = 'all' | 'deposit' | 'withdrawal' | 'order' | 'refund';

export function useTransactions(filter: TransactionFilter = 'all') {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['transactions', user?.id, filter],
    queryFn: async () => {
      const params = new URLSearchParams({ type: filter === 'withdrawal' ? 'all' : filter, limit: '50' });
      const res = await fetch(`/api/wallet/transactions?${params}`);
      if (!res.ok) throw new Error('Failed to fetch transactions');
      const data = await res.json();
      const txns = data.transactions ?? [];
      // withdrawal is not a real type in our DB — filter client-side
      if (filter === 'withdrawal') return txns.filter((t: any) => t.type === 'withdrawal');
      return txns;
    },
    enabled: !!user?.id,
    staleTime: 60000,
    refetchOnMount: false,
  });
}
