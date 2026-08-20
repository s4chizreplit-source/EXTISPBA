import { ReactNode, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, ShieldAlert } from 'lucide-react';

interface AdminGuardProps {
  children: ReactNode;
}

/**
 * Server-verified admin guard.
 * Does NOT trust client-side role — re-checks from DB every time.
 */
export function AdminGuard({ children }: AdminGuardProps) {
  const { user, isLoading } = useAuth();
  const [verified, setVerified] = useState<boolean | null>(null);

  useEffect(() => {
    // Wait for auth to resolve before deciding
    if (isLoading) return;

    if (!user) {
      setVerified(false);
      return;
    }

    let cancelled = false;
    // Reset to loading state while we re-verify against the DB, so we don't
    // briefly render the "Access Denied" screen from a stale previous check.
    setVerified(null);

    const verify = async () => {
      try {
        const { data, error } = await supabase
          .from('user_roles')
          .select('role')
          .eq('user_id', user.id)
          .eq('role', 'admin')
          .maybeSingle();

        if (!cancelled) {
          setVerified(!error && !!data);
        }
      } catch {
        if (!cancelled) setVerified(false);
      }
    };

    verify();
    return () => { cancelled = true; };
  }, [user?.id, isLoading]);

  if (isLoading || verified === null) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(180deg, #f5f9ff 0%, #dbeafe 40%, #bfdbfe 70%, #f5f9ff 100%)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-green-500" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(180deg, #f5f9ff 0%, #dbeafe 40%, #bfdbfe 70%, #f5f9ff 100%)' }}>
        <div className="text-center p-8 bg-white/80 rounded-2xl shadow-lg max-w-md">
          <ShieldAlert className="w-16 h-16 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h2>
          <p className="text-gray-600">You don't have admin privileges.</p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
