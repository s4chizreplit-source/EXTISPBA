import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Zap, Loader2 } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

const QUICK_AMOUNTS = [100, 500, 1000, 5000];
const MIN_AMOUNT = 50;
const MAX_AMOUNT = 100000;

export default function ZapUpiDepositCard() {
  const [amount, setAmount] = useState<string>('500');
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const polledRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => {
    const deposit = searchParams.get('deposit');
    const orderId = searchParams.get('order_id');
    if (!deposit || !orderId) return;
    if (!orderId.startsWith('zap_')) return;
    if (polledRef.current === orderId) return;
    polledRef.current = orderId;

    if (deposit === 'failed') { toast.error('Payment failed. Please try again.'); clearParams(); return; }
    if (deposit === 'timeout') { toast.error('Payment timed out. If deducted, will reflect shortly.'); clearParams(); pollUntilCredited(orderId); return; }
    if (deposit === 'success') pollUntilCredited(orderId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  function clearParams() {
    const next = new URLSearchParams(searchParams);
    next.delete('deposit'); next.delete('order_id');
    setSearchParams(next, { replace: true });
  }

  async function pollUntilCredited(orderId: string) {
    setPolling(true);
    const start = Date.now();
    const MAX_MS = 60_000; const INTERVAL = 3_000;
    toast.loading('Verifying payment…', { id: `zap-${orderId}` });
    while (Date.now() - start < MAX_MS) {
      if (!mountedRef.current) { toast.dismiss(`zap-${orderId}`); return; }
      try {
        const { data, error } = await supabase.functions.invoke('zapupi-sync-deposit', { body: { order_id: orderId } });
        if (error) throw error;
        if (!mountedRef.current) { toast.dismiss(`zap-${orderId}`); return; }
        if (data?.status === 'success' || data?.credited) {
          toast.success('🎉 Wallet credited successfully!', { id: `zap-${orderId}` });
          queryClient.invalidateQueries({ queryKey: ['wallet'] });
          queryClient.invalidateQueries({ queryKey: ['transactions'] });
          clearParams(); setPolling(false); return;
        }
        if (data?.status === 'failed') { toast.error('Payment failed.', { id: `zap-${orderId}` }); clearParams(); setPolling(false); return; }
      } catch (e) { console.error('sync error', e); }
      await new Promise((r) => setTimeout(r, INTERVAL));
    }
    if (!mountedRef.current) { toast.dismiss(`zap-${orderId}`); return; }
    toast.error('Could not confirm payment in time. If deducted, credit will follow automatically.', { id: `zap-${orderId}` });
    queryClient.invalidateQueries({ queryKey: ['wallet'] });
    queryClient.invalidateQueries({ queryKey: ['transactions'] });
    clearParams(); setPolling(false);
  }

  async function handlePay() {
    const inr = Math.floor(Number(amount) || 0);
    if (!inr || inr < MIN_AMOUNT) return toast.error(`Minimum deposit is ₹${MIN_AMOUNT}`);
    if (inr > MAX_AMOUNT) return toast.error(`Maximum deposit is ₹${MAX_AMOUNT}`);
    setLoading(true);
    try {
      // Always attach a fresh access token — invoke() can send a stale/empty one
      let { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        const refreshed = await supabase.auth.refreshSession();
        sess = { session: refreshed.data.session } as any;
      }
      const accessToken = sess.session?.access_token;
      if (!accessToken) {
        setLoading(false);
        return toast.error('Session expired — please sign in again.');
      }
      const { data, error } = await supabase.functions.invoke('zapupi-create-order', {
        body: { amount_inr: inr },
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (error) {
        // Surface the real server message instead of the generic non-2xx text
        let msg = error.message;
        try {
          const ctx: any = (error as any).context;
          if (ctx?.json) { const b = await ctx.json(); msg = b?.error || msg; }
          else if (ctx?.text) { const t = await ctx.text(); msg = t || msg; }
        } catch { /* keep default */ }
        throw new Error(msg);
      }
      if (!data?.payment_url) throw new Error(data?.error || 'No payment URL');
      window.location.href = data.payment_url;
    } catch (e: any) {
      console.error(e);
      toast.error(e?.message || 'Could not start payment');
      setLoading(false);
    }

  }

  return (
    <div className="relative rounded-2xl bg-card border border-border p-6 backdrop-blur-md shadow-[0_20px_60px_-20px_rgba(124,58,237,0.2)]">
      <div className="relative flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-card border border-border flex items-center justify-center">
            <Zap className="w-4 h-4 text-white" fill="white" />
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-white leading-tight">Pay with UPI</h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">GPay · PhonePe · Paytm · BHIM</p>
          </div>
        </div>
        <span className="px-2 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-[9px] font-semibold uppercase tracking-wider">
          Instant
        </span>
      </div>

      <div className="relative space-y-4">
        <div>
          <label className="text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground ml-1">Amount</label>
          <div className="mt-1.5 relative">
            <span className="absolute left-4 top-1/2 -translate-y-1/2 text-xl font-semibold text-muted-foreground">₹</span>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_AMOUNT}
              max={MAX_AMOUNT}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              className="w-full bg-card border border-border rounded-xl py-3.5 pl-10 pr-16 text-xl font-bold tracking-tight text-white outline-none focus:border-border focus:bg-card transition-all placeholder:text-muted-foreground"
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[11px] font-semibold text-muted-foreground tracking-wider">INR</span>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-2">
          {QUICK_AMOUNTS.map((q) => {
            const active = Number(amount) === q;
            return (
              <button
                key={q}
                onClick={() => setAmount(String(q))}
                className={
                  'py-2.5 rounded-lg text-xs font-semibold transition-all border ' +
                  (active
                    ? 'bg-card border-border text-white'
                    : 'bg-card border-border text-muted-foreground hover:bg-card hover:border-border hover:text-foreground')
                }
              >
                ₹{q >= 1000 ? `${q / 1000}k` : q}
              </button>
            );
          })}
        </div>

        <button
          onClick={handlePay}
          disabled={loading || polling}
          className="relative w-full py-3.5 rounded-xl font-semibold text-black flex items-center justify-center gap-2 transition-all active:scale-[0.98] disabled:opacity-60 bg-white hover:bg-primary shadow-[0_10px_24px_rgba(29,78,216,0.25)]"
        >
          {loading ? (<><Loader2 className="w-4 h-4 animate-spin" /> <span>Opening UPI…</span></>)
            : polling ? (<><Loader2 className="w-4 h-4 animate-spin" /> <span>Verifying…</span></>)
            : (<><Zap className="w-4 h-4" fill="white" /> <span>Pay ₹{Math.floor(Number(amount) || 0)} via UPI</span></>)}
        </button>

        <div className="flex items-center justify-center gap-1.5 pt-1">
          <div className="w-1 h-1 rounded-full bg-emerald-400 animate-pulse" />
          <p className="text-[10px] text-muted-foreground font-medium">Auto-credit in seconds · No manual approval</p>
        </div>
      </div>
    </div>
  );
}
