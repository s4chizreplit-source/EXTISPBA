import { useQuery } from '@tanstack/react-query';

export function useMaintenanceMode() {
  const { data: isMaintenanceMode = false } = useQuery({
    queryKey: ['maintenance-mode'],
    queryFn: async () => {
      try {
        const res = await fetch('/api/platform/maintenance');
        if (!res.ok) return false;
        const data = await res.json();
        return data.maintenanceMode ?? false;
      } catch {
        return false;
      }
    },
    staleTime: 60000,
    gcTime: 5 * 60 * 1000,
    refetchInterval: 60000, // poll every 60s instead of realtime
    refetchOnWindowFocus: false,
  });

  return { isMaintenanceMode };
}
