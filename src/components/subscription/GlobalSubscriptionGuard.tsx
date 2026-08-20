import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';
import { MaintenancePage } from '@/components/MaintenanceMode';

interface GlobalSubscriptionGuardProps {
  children: React.ReactNode;
}

// Routes that are completely public (no login needed)
const PUBLIC_ROUTES = ['/', '/auth'];

/**
 * ZERO-BLOCKING GLOBAL GUARD
 * NEVER shows a loading spinner - renders children immediately
 * Only blocks rendering for maintenance mode (non-admin users)
 */
export function GlobalSubscriptionGuard({ children }: GlobalSubscriptionGuardProps) {
  const location = useLocation();
  const { isAdmin } = useAuth();
  const { isMaintenanceMode } = useMaintenanceMode();

  const isPublicRoute = useMemo(() => PUBLIC_ROUTES.includes(location.pathname), [location.pathname]);
  const isAdminRoute = useMemo(() => location.pathname.startsWith('/admin'), [location.pathname]);
  
  // Maintenance mode: show maintenance page to non-admin users
  if (isMaintenanceMode && !isAdmin && !isAdminRoute && !isPublicRoute) {
    return <MaintenancePage />;
  }

  // ALWAYS render children instantly - no loading spinner ever
  return <>{children}</>;
}
