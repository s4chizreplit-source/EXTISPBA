import { useState, useEffect, createContext, useContext, ReactNode, useCallback } from 'react';
import type { User, Session } from '@supabase/supabase-js';
import type { Profile, Wallet, AppRole } from '@/lib/supabase';

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  wallet: Wallet | null;
  role: AppRole | null;
  isLoading: boolean;
  isAdmin: boolean;
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (email: string, password: string, fullName?: string) => Promise<{ error: Error | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  refreshWallet: () => Promise<void>;
}

type AuthPayload = {
  user: { id: string; email: string; fullName?: string; role?: string; createdAt?: string };
  profile: Profile | null;
  wallet: Wallet | null;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function toUser(row: AuthPayload['user']): User {
  return {
    id: row.id,
    email: row.email,
    aud: 'authenticated',
    role: 'authenticated',
    app_metadata: {},
    user_metadata: { full_name: row.fullName || '' },
    created_at: row.createdAt || new Date().toISOString(),
    updated_at: row.createdAt || new Date().toISOString(),
  } as User;
}

async function authRequest(path: string, init?: RequestInit): Promise<{ response: Response; data: any }> {
  const response = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    ...init,
  });
  let data: any = {};
  try { data = await response.json(); } catch { /* empty response */ }
  return { response, data };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const applyPayload = useCallback((payload: AuthPayload | null) => {
    if (!payload?.user) {
      setUser(null);
      setProfile(null);
      setWallet(null);
      setRole(null);
      return;
    }
    setUser(toUser(payload.user));
    setProfile(payload.profile);
    setWallet(payload.wallet);
    setRole((payload.user.role as AppRole) || 'user');
  }, []);

  const refreshAuth = useCallback(async () => {
    const { response, data } = await authRequest('/api/auth/me');
    if (response.ok) applyPayload(data);
    else applyPayload(null);
  }, [applyPayload]);

  useEffect(() => {
    refreshAuth()
      .catch(() => applyPayload(null))
      .finally(() => setIsLoading(false));
  }, [refreshAuth, applyPayload]);

  const signIn = async (email: string, password: string) => {
    try {
      const { response, data } = await authRequest('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
      });
      if (!response.ok) return { error: new Error(data.error || 'Invalid email or password') };
      applyPayload(data);
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signUp = async (email: string, password: string, fullName?: string) => {
    try {
      const { response, data } = await authRequest('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, fullName: fullName || '' }),
      });
      if (!response.ok) return { error: new Error(data.error || 'Unable to create account') };
      applyPayload(data);
      return { error: null };
    } catch (error) {
      return { error: error as Error };
    }
  };

  const signOut = async () => {
    try { await authRequest('/api/auth/logout', { method: 'POST' }); } finally { applyPayload(null); }
  };

  const refreshProfile = async () => { await refreshAuth(); };
  const refreshWallet = async () => { await refreshAuth(); };

  const value = {
    user, session, profile, wallet, role, isLoading,
    isAdmin: role === 'admin',
    signIn, signUp, signOut, refreshProfile, refreshWallet,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}