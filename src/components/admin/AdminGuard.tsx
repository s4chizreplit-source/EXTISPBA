import { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2, ShieldAlert } from 'lucide-react';

interface AdminGuardProps {
  children: ReactNode;
}

/**
 * Admin guard — uses role already loaded by useAuth (/api/auth/me).
 * No separate Supabase call needed.
 */
export function AdminGuard({ children }: AdminGuardProps) {
  const { user, isLoading, isAdmin } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(180deg, #f5f9ff 0%, #dbeafe 40%, #bfdbfe 70%, #f5f9ff 100%)' }}>
        <Loader2 className="w-8 h-8 animate-spin text-green-500" />
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  if (!isAdmin) {
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
