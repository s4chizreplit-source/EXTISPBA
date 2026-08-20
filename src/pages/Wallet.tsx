import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DashboardLayout } from '@/components/layout/DashboardLayout';
import { useWallet } from '@/hooks/useWallet';
import { useTransactions, type TransactionFilter } from '@/hooks/useTransactions';
import { useCurrency } from '@/hooks/useCurrency';

import OxapayDepositCard from '@/components/wallet/OxapayDepositCard';
import ZapUpiDepositCard from '@/components/wallet/ZapUpiDepositCard';
import {
  Wallet as WalletIcon,
  ArrowUpRight,
  ArrowDownLeft,
  RefreshCw,
  ExternalLink,
  Zap,
  Bitcoin,
  Sparkles,
  ShieldCheck,
} from 'lucide-react';

export default function Wallet() {
  const { wallet } = useWallet();
  const { formatPrice, rates } = useCurrency();
  const [filter, setFilter] = useState<TransactionFilter>('all');
  const [searchParams, setSearchParams] = useSearchParams();
  // Default to crypto tab when returning from OxaPay so the deposit card
  // mounts and its poll-until-credited effect fires.
  const initialMethod: 'upi' | 'crypto' =
    (searchParams.get('order_id') || '').startsWith('oxw_') ? 'crypto' : 'upi';
  const [method, setMethod] = useState<'upi' | 'crypto'>(initialMethod);
  const { data: transactions } = useTransactions(filter);

  const getIcon = (type: string) => {
    switch (type) {
      case 'deposit': return <ArrowDownLeft className="h-4 w-4 text-emerald-400" />;
      case 'order': return <ArrowUpRight className="h-4 w-4 text-rose-400" />;
      case 'refund': return <RefreshCw className="h-4 w-4 text-sky-300" />;
      default: return <WalletIcon className="h-4 w-4 text-muted-foreground" />;
    }
  };
  const getIconBg = (type: string) => {
    switch (type) {
      case 'deposit': return 'bg-emerald-500/10 border border-emerald-500/20';
      case 'order': return 'bg-rose-500/10 border border-rose-500/20';
      case 'refund': return 'bg-sky-500/10 border border-sky-500/20';
      default: return 'bg-card border border-border';
    }
  };
  const getAmountColor = (type: string) => {
    switch (type) {
      case 'deposit': return 'text-emerald-400';
      case 'order': return 'text-rose-400';
      case 'refund': return 'text-sky-300';
      default: return 'text-muted-foreground';
    }
  };
  const fmtDate = (d: string) =>
    new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

  const displayTransactions = (() => {
    if (!transactions?.length) return [];
    const adjustments = new Map<string, number>();
    const inrRate = rates.INR || 83.5;
    for (const tx of transactions) {
      if (tx.payment_method !== 'razorpay_auto' || !tx.payment_reference) continue;
      const originalReference = tx.payment_reference.endsWith('_exact_credit_fix')
        ? tx.payment_reference.replace(/_exact_credit_fix$/, '')
        : tx.payment_reference.endsWith('_fee_adjust')
          ? tx.payment_reference.replace(/_fee_adjust$/, '') : null;
      if (!originalReference) continue;
      adjustments.set(originalReference, (adjustments.get(originalReference) || 0) + Number(tx.amount || 0));
    }
    return transactions
      .filter((tx) => !(tx.payment_method === 'razorpay_auto' && tx.payment_reference && (tx.payment_reference.endsWith('_exact_credit_fix') || tx.payment_reference.endsWith('_fee_adjust'))))
      .map((tx) => {
        const adjustment = tx.payment_method === 'razorpay_auto' && tx.payment_reference ? adjustments.get(tx.payment_reference) || 0 : 0;
        const displayAmount = Number(tx.amount || 0) + adjustment;
        const displayBalanceAfter = tx.balance_after != null ? Number(tx.balance_after) + adjustment : null;
        const displayDescription = tx.payment_method === 'razorpay_auto' && adjustment !== 0
          ? `Wallet top-up via Razorpay (₹${(displayAmount * inrRate).toFixed(2)} exact credit)`
          : (tx.description || tx.type.charAt(0).toUpperCase() + tx.type.slice(1));
        return { ...tx, displayAmount, displayBalanceAfter, displayDescription };
      });
  })();

  return (
    <DashboardLayout>
      <style>{`
        @keyframes vault-pulse { 0%,100%{opacity:.6} 50%{opacity:1} }
      `}</style>
      <div className="min-h-full bg-[#f5f9ff] -mx-4 -my-6 md:-mx-6 md:-my-8 px-4 py-6 md:px-8 md:py-10 relative overflow-hidden">
        {/* Subtle ambient glow */}
        <div aria-hidden className="pointer-events-none absolute top-0 left-1/2 -translate-x-1/2 w-[700px] h-[400px] bg-primary/10 blur-[120px] rounded-full" />

        <div className="max-w-2xl mx-auto space-y-6 relative">
          {/* Page header */}
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="h-1.5 w-1.5 rounded-full bg-primary shadow-[0_0_10px_rgba(216,180,254,0.7)]" style={{ animation: 'vault-pulse 2s ease-in-out infinite' }} />
                <p className="text-[11px] font-medium tracking-[0.18em] uppercase text-primary/70">Vault</p>
              </div>
              <h1 className="text-3xl font-bold text-white tracking-tight">Wallet</h1>
            </div>
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card border border-border">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
              <span className="text-[11px] font-semibold text-muted-foreground">Secure</span>
            </div>
          </div>

          {/* Compact Balance Card — landing page style */}
          <div className="relative rounded-2xl border border-border bg-card backdrop-blur-md p-5 shadow-[0_0_40px_rgba(168,85,247,0.08)]">
            <div className="flex items-center justify-between gap-4 flex-wrap">
              {/* Left: balance */}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 mb-1.5">
                  <span className="h-1 w-1 rounded-full bg-emerald-400" style={{ animation: 'vault-pulse 1.8s ease-in-out infinite' }} />
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Balance</p>
                </div>
                <div className="flex items-baseline gap-2">
                  <h2 className="text-[28px] leading-none font-bold tracking-tight text-white">{formatPrice(wallet?.balance || 0)}</h2>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest">USD</span>
                </div>
              </div>

              {/* Right: mini stats */}
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border border-border">
                  <ArrowDownLeft className="w-3.5 h-3.5 text-emerald-400" />
                  <div className="leading-tight">
                    <p className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">In</p>
                    <p className="text-[11px] font-semibold text-white">{formatPrice(wallet?.total_deposited || 0)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-card border border-border">
                  <ArrowUpRight className="w-3.5 h-3.5 text-rose-400" />
                  <div className="leading-tight">
                    <p className="text-[8px] font-semibold uppercase tracking-wider text-muted-foreground">Out</p>
                    <p className="text-[11px] font-semibold text-white">{formatPrice(wallet?.total_spent || 0)}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Deposit section — tabbed */}
          <div className="relative">
            <div className="flex items-end justify-between mb-3 px-1">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Add Funds</p>
                <h3 className="text-lg font-bold text-white mt-0.5">Choose payment method</h3>
              </div>
            </div>

            {/* Method switcher — minimal landing style */}
            <div className="grid grid-cols-2 gap-1 p-1 rounded-xl bg-card border border-border mb-4 backdrop-blur-sm">
              <button
                onClick={() => setMethod('upi')}
                className={
                  'relative flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium text-sm transition-all ' +
                  (method === 'upi'
                    ? 'bg-card text-white border border-border shadow-sm'
                    : 'text-muted-foreground hover:text-foreground/80')
                }
              >
                <Zap className="w-3.5 h-3.5" />
                UPI · INR
                {method === 'upi' && (
                  <span className="ml-1 h-1.5 w-1.5 rounded-full bg-emerald-400" style={{ animation: 'vault-pulse 1.8s ease-in-out infinite' }} />
                )}
              </button>
              <button
                onClick={() => setMethod('crypto')}
                className={
                  'flex items-center justify-center gap-2 py-2.5 rounded-lg font-medium text-sm transition-all ' +
                  (method === 'crypto'
                    ? 'bg-card text-white border border-border shadow-sm'
                    : 'text-muted-foreground hover:text-foreground/80')
                }
              >
                <Bitcoin className="w-3.5 h-3.5" />
                Crypto · USD
              </button>
            </div>

            {method === 'upi' ? <ZapUpiDepositCard /> : <OxapayDepositCard />}
          </div>

          {/* Transaction History */}
          <div className="relative rounded-2xl bg-card border border-border p-6 backdrop-blur-md">
            <div className="flex items-center justify-between mb-5">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Activity</p>
                <h3 className="text-lg font-bold text-white mt-0.5">Transaction History</h3>
              </div>
              <span className="text-[11px] text-muted-foreground">{displayTransactions.length} total</span>
            </div>

            <div className="flex gap-1 p-1 bg-card rounded-xl mb-5 border border-border">
              {(['all', 'deposit', 'order', 'refund'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={
                    'flex-1 py-2 rounded-lg text-xs font-semibold transition-all ' +
                    (filter === f
                      ? 'bg-card text-white border border-border'
                      : 'text-muted-foreground hover:text-foreground/70')
                  }
                >
                  {f === 'all' ? 'All' : f === 'deposit' ? 'Deposits' : f === 'order' ? 'Orders' : 'Refunds'}
                </button>
              ))}
            </div>

            {displayTransactions.length > 0 ? (
              <div className="space-y-2">
                {displayTransactions.map((tx) => (
                  <div
                    key={tx.id}
                    className="flex items-center justify-between p-3.5 rounded-xl bg-card border border-border hover:bg-card hover:border-border transition-colors"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className={'w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center ' + getIconBg(tx.type)}>
                        {getIcon(tx.type)}
                      </div>
                      <div className="min-w-0">
                        <p className="font-medium text-[13px] leading-tight truncate max-w-[240px] text-muted-foreground">
                          {tx.displayDescription}
                        </p>
                        <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1">
                          {tx.payment_method && (
                            <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded bg-card border border-border text-muted-foreground">
                              {tx.payment_method.replace(/_/g, ' ').toUpperCase()}
                            </span>
                          )}
                          <span className={'text-[9px] font-semibold px-1.5 py-0.5 rounded ' + (tx.status === 'pending' ? 'bg-amber-500/10 text-amber-300 border border-amber-500/20' : tx.status === 'completed' ? 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20' : 'bg-rose-500/10 text-rose-300 border border-rose-500/20')}>
                            {tx.status}
                          </span>
                          <span className="text-[11px] text-muted-foreground">{fmtDate(tx.created_at!)}</span>
                          {tx.payment_reference && tx.payment_method === 'usdt_bep20' && (
                            <a href={`https://bscscan.com/tx/${tx.payment_reference}`} target="_blank" rel="noopener noreferrer" className="text-[11px] flex items-center gap-0.5 hover:underline text-muted-foreground hover:text-foreground">
                              BSCScan <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right flex-shrink-0 ml-4">
                      <p className={'font-bold text-[15px] ' + getAmountColor(tx.type)}>
                        {tx.type === 'order' ? '−' : '+'}{formatPrice(Math.abs(Number(tx.displayAmount)))}
                      </p>
                      {tx.displayBalanceAfter != null && (
                        <p className="text-[11px] mt-0.5 text-muted-foreground">Bal: {formatPrice(Number(tx.displayBalanceAfter))}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-14 text-center">
                <div className="relative w-14 h-14 rounded-2xl bg-card flex items-center justify-center mb-4 border border-border">
                  <WalletIcon className="w-6 h-6 text-muted-foreground" />
                </div>
                <p className="text-muted-foreground text-sm font-medium">No transactions yet</p>
                <p className="text-muted-foreground text-xs mt-1">Your deposits and spending will appear here</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </DashboardLayout>
  );
}
