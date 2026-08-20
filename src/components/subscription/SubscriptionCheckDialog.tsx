// Subscription system removed — this dialog is a no-op shim kept so existing
// imports keep compiling. It never renders anything.

interface Props {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  initialPlan?: 'monthly' | 'yearly' | 'lifetime';
}

export function SubscriptionCheckDialog(_props: Props) {
  return null;
}

export default SubscriptionCheckDialog;
