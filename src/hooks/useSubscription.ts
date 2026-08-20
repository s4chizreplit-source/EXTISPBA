// Subscription system removed — every logged-in user can place orders after
// adding funds. This hook is kept as a no-op shim so existing imports keep
// working; it always reports full access.

export interface Subscription {
  id: string;
  user_id: string;
  plan_type: 'none' | 'monthly' | 'lifetime' | 'trial';
  status: 'inactive' | 'active' | 'expired' | 'cancelled';
  activated_at: string | null;
  expires_at: string | null;
  created_at: string;
}

export function useSubscription() {
  return {
    subscription: null as Subscription | null,
    pendingRequest: null,
    hasActiveSubscription: true,
    isSubscriptionExpired: false,
    hasPendingRequest: false,
    isTrial: false,
    trialDaysRemaining: null,
    isLoading: false,
  };
}
