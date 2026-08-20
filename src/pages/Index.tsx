import React from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight, Sparkles, Zap, Shield, BarChart3, Wallet as WalletIcon,
  Shuffle, Activity, Check, Instagram, Youtube, MessageCircle, Globe
} from 'lucide-react';
import { PageMeta } from '@/components/seo/PageMeta';
import logo from '@/assets/logo.jpg';
import { useAuth } from '@/hooks/useAuth';

/**
 * Extips Panel Pro — Light Sky Blue v3.0 landing.
 * Clean white/sky-blue canvas, fresh modern look, dark readable text.
 */

const Index = () => {
  const { user } = useAuth();

  return (
    <div className="min-h-screen w-full overflow-x-hidden antialiased"
      style={{ background: 'linear-gradient(160deg, #e0f2fe 0%, #f0f9ff 40%, #e8f4fd 70%, #dbeafe 100%)' }}>
      <PageMeta
        title="Extips Panel Pro — The Growth Engine for Social Magic"
        description="Precision-engineered organic engagement for Instagram, TikTok and YouTube. Multi-provider failover, wallet, live dashboard."
        canonicalPath="/"
        breadcrumbs={[{ name: 'Home', path: '/' }]}
      />

      {/* Soft ambient blobs */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute top-[-8%] left-1/2 -translate-x-1/2 w-[700px] h-[400px] rounded-full"
          style={{ background: 'radial-gradient(ellipse, rgba(56,139,253,0.18) 0%, transparent 70%)' }} />
        <div className="absolute top-[35%] right-[-8%] w-[400px] h-[400px] rounded-full"
          style={{ background: 'radial-gradient(ellipse, rgba(125,211,252,0.2) 0%, transparent 70%)' }} />
        <div className="absolute bottom-[-10%] left-[-5%] w-[450px] h-[450px] rounded-full"
          style={{ background: 'radial-gradient(ellipse, rgba(96,165,250,0.15) 0%, transparent 70%)' }} />
      </div>

      {/* Nav */}
      <header className="sticky top-0 z-40 backdrop-blur-md border-b"
        style={{ background: 'rgba(224,242,254,0.75)', borderColor: '#bae6fd' }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <img src={logo} alt="Extips Panel Pro" width={32} height={32} fetchPriority="high" decoding="async"
              className="h-8 w-8 rounded-md object-cover ring-1" style={{ ringColor: '#93c5fd' }} />
            <span className="text-[15px] font-semibold tracking-tight text-slate-800">Extips Panel Pro</span>
            <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] ml-2 px-1.5 py-0.5 rounded border font-semibold"
              style={{ color: '#2563eb', borderColor: '#93c5fd', background: '#eff6ff' }}>v3</span>
          </Link>

          <nav className="hidden md:flex items-center gap-8 text-sm text-slate-500">
            <a href="#features" className="hover:text-slate-800 transition-colors">Features</a>
            <a href="#platforms" className="hover:text-slate-800 transition-colors">Platforms</a>
            <Link to="/support" className="hover:text-slate-800 transition-colors">Support</Link>
          </nav>

          <div className="flex items-center gap-2.5">
            <Link to="/auth"
              className="hidden sm:inline-flex text-sm text-slate-500 hover:text-slate-800 px-3 py-2 rounded-lg transition-colors">
              Sign in
            </Link>
            <Link to="/auth"
              className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg text-white transition-all active:scale-[0.98]"
              style={{ background: 'linear-gradient(135deg,#2563eb,#0ea5e9)', boxShadow: '0 6px 20px rgba(37,99,235,0.30)' }}>
              Get started <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="relative">
          <div className="max-w-5xl mx-auto px-5 sm:px-8 pt-20 sm:pt-28 pb-20 sm:pb-28 text-center">

            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border mb-8"
              style={{ borderColor: '#93c5fd', background: '#eff6ff' }}>
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full rounded-full opacity-75 animate-ping"
                  style={{ background: '#3b82f6' }} />
                <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: '#2563eb' }} />
              </span>
              <span className="text-[11px] font-semibold tracking-[0.18em] uppercase" style={{ color: '#2563eb' }}>
                Extips Panel Pro · Software v3.0
              </span>
            </div>

            {/* Headline */}
            <h1 className="text-5xl sm:text-7xl lg:text-[88px] font-extrabold tracking-tight leading-[1.02] mb-6 text-slate-900"
              style={{ fontFamily: "'Inter', system-ui, sans-serif" }}>
              The Growth Engine
              <br />
              for Social{' '}
              <span className="italic font-bold"
                style={{ fontFamily: "'Playfair Display', Georgia, serif", color: '#2563eb' }}>
                Magic
              </span>
            </h1>

            {/* Sub */}
            <p className="text-base sm:text-xl text-slate-600 max-w-2xl mx-auto mb-10 leading-relaxed">
              Master Instagram, TikTok, and YouTube organic engagement through a
              precision-engineered platform. No bots — just high-performance
              software with multi-provider failover, wallet, and a live dashboard.
            </p>

            {/* CTA */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
              <Link to="/auth"
                className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 font-semibold rounded-xl text-white transition-all active:scale-[0.98]"
                style={{ background: 'linear-gradient(135deg,#2563eb,#0ea5e9)', boxShadow: '0 10px 28px rgba(37,99,235,0.28)' }}>
                Launch Dashboard <ArrowRight className="h-4 w-4" />
              </Link>
              <Link to="/wallet"
                className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 font-semibold rounded-xl text-slate-700 border transition-all hover:border-blue-300"
                style={{ background: 'rgba(255,255,255,0.7)', borderColor: '#93c5fd', backdropFilter: 'blur(8px)' }}>
                Add funds
              </Link>
            </div>

            {/* Platforms strip */}
            <div className="mt-20 pt-8" style={{ borderTop: '1px solid #bae6fd' }}>
              <p className="text-[10px] tracking-[0.24em] uppercase text-slate-400 mb-5">
                Built for the platforms that matter
              </p>
              <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-slate-400">
                {[
                  { Icon: Instagram, label: 'INSTAGRAM' },
                  { Icon: Sparkles, label: 'TIKTOK' },
                  { Icon: Youtube, label: 'YOUTUBE' },
                  { Icon: MessageCircle, label: 'TELEGRAM' },
                  { Icon: Globe, label: 'FACEBOOK' },
                ].map(({ Icon, label }) => (
                  <div key={label} className="flex items-center gap-2 hover:text-slate-600 transition-colors">
                    <Icon className="h-4 w-4" />
                    <span className="text-xs font-semibold tracking-[0.18em]">{label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Features */}
        <section id="features" className="relative py-24 sm:py-32" style={{ borderTop: '1px solid #bae6fd' }}>
          <div className="max-w-6xl mx-auto px-5 sm:px-8">
            <div className="max-w-2xl mb-14">
              <p className="text-[11px] tracking-[0.22em] uppercase font-semibold mb-4" style={{ color: '#2563eb' }}>
                The Software
              </p>
              <h2 className="text-3xl sm:text-5xl font-bold tracking-tight leading-[1.1] text-slate-900">
                Engineered like infrastructure,
                <br />
                <span className="italic" style={{ fontFamily: "'Playfair Display', Georgia, serif", color: '#2563eb' }}>
                  used like a product.
                </span>
              </h2>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
              {[
                {
                  Icon: Activity,
                  title: 'Organic Drip-Feed',
                  body: 'Time-spread delivery with natural variance — engagement that looks human because the schedule is.',
                },
                {
                  Icon: Shuffle,
                  title: 'Multi-Provider Failover',
                  body: 'Auto-rotation across providers with live balance monitoring. Zero balance? Backup provider takes over.',
                },
                {
                  Icon: WalletIcon,
                  title: 'Wallet & UPI Deposits',
                  body: 'Fully automatic ZapUPI top-ups. No screenshots, no approvals. Credited the second payment clears.',
                },
                {
                  Icon: BarChart3,
                  title: 'Live Dashboard',
                  body: 'Real-time runs, status, charts. Watch every dispatch tick across providers as it happens.',
                },
                {
                  Icon: Shield,
                  title: 'No Subscription Needed',
                  body: 'Just add funds to your wallet and start ordering instantly — no plans, no gates, no waiting.',
                },
                {
                  Icon: Zap,
                  title: 'Bundles & Mass Order',
                  body: 'One click ships engagement combos across multiple posts — built for creators who scale fast.',
                },
              ].map(({ Icon, title, body }) => (
                <div key={title}
                  className="group relative rounded-2xl border p-6 transition-all hover:shadow-md"
                  style={{ background: 'rgba(255,255,255,0.75)', borderColor: '#bae6fd', backdropFilter: 'blur(8px)' }}>
                  <div className="h-10 w-10 rounded-lg flex items-center justify-center mb-5"
                    style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                    <Icon className="h-5 w-5" style={{ color: '#2563eb' }} />
                  </div>
                  <h3 className="text-base font-semibold mb-2 text-slate-800">{title}</h3>
                  <p className="text-sm text-slate-500 leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Platforms */}
        <section id="platforms" className="relative py-24" style={{ borderTop: '1px solid #bae6fd' }}>
          <div className="max-w-6xl mx-auto px-5 sm:px-8 grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <p className="text-[11px] tracking-[0.22em] uppercase font-semibold mb-4" style={{ color: '#2563eb' }}>
                Cross-platform
              </p>
              <h2 className="text-3xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5 text-slate-900">
                One control room for{' '}
                <span className="italic" style={{ fontFamily: "'Playfair Display', Georgia, serif", color: '#2563eb' }}>
                  every channel.
                </span>
              </h2>
              <p className="text-slate-600 leading-relaxed mb-8 max-w-lg">
                Plug in a URL, pick a bundle, hit launch. Extips Panel Pro handles the
                routing, the dispatch, and the retries — so you don't have to babysit any of it.
              </p>
              <ul className="space-y-3">
                {[
                  'Instagram followers, likes, views & reels',
                  'TikTok views, hearts & followers',
                  'YouTube views, subs & engagement',
                  'Telegram, Facebook, X — all routed',
                ].map((t) => (
                  <li key={t} className="flex items-center gap-3 text-sm text-slate-700">
                    <span className="h-5 w-5 rounded-full flex items-center justify-center shrink-0"
                      style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                      <Check className="h-3 w-3" style={{ color: '#2563eb' }} />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>

            <div className="relative">
              <div className="absolute -inset-4 rounded-full blur-2xl"
                style={{ background: 'rgba(37,99,235,0.10)' }} />
              <div className="relative rounded-2xl border p-6 shadow-md"
                style={{ background: 'rgba(255,255,255,0.85)', borderColor: '#bae6fd', backdropFilter: 'blur(12px)' }}>
                <div className="flex items-center gap-1.5 mb-5">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#fca5a5' }} />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#fde68a' }} />
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: '#86efac' }} />
                  <span className="ml-auto text-[10px] uppercase tracking-[0.18em] text-slate-400">extipspanel.com</span>
                </div>
                <div className="space-y-3">
                  {[
                    { p: 'Instagram', t: 'Reel views', q: '12,500', s: 'Running' },
                    { p: 'TikTok', t: 'Hearts', q: '4,200', s: 'Queued' },
                    { p: 'YouTube', t: 'Subscribers', q: '850', s: 'Complete' },
                    { p: 'Instagram', t: 'Followers', q: '2,000', s: 'Running' },
                  ].map((r, i) => (
                    <div key={i} className="flex items-center justify-between rounded-lg border px-3.5 py-3"
                      style={{ background: '#f0f9ff', borderColor: '#bae6fd' }}>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-slate-400 mb-0.5">{r.p}</div>
                        <div className="text-sm font-medium text-slate-700">{r.t}</div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-semibold text-slate-800">{r.q}</div>
                        <div className={`text-[10px] uppercase tracking-widest font-semibold ${
                          r.s === 'Complete' ? 'text-emerald-500' : r.s === 'Queued' ? 'text-amber-500' : 'text-blue-500'
                        }`}>{r.s}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* CTA band */}
        <section className="relative py-24" style={{ borderTop: '1px solid #bae6fd' }}>
          <div className="max-w-4xl mx-auto px-5 sm:px-8 text-center">
            <h2 className="text-3xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5 text-slate-900">
              Ready to ship{' '}
              <span className="italic" style={{ fontFamily: "'Playfair Display', Georgia, serif", color: '#2563eb' }}>
                real growth?
              </span>
            </h2>
            <p className="text-slate-600 max-w-xl mx-auto mb-8">
              Skip the panel templates. Run growth like software.
            </p>
            <Link to="/auth"
              className="inline-flex items-center justify-center gap-2 px-7 py-3.5 font-semibold rounded-xl text-white transition-all active:scale-[0.98]"
              style={{ background: 'linear-gradient(135deg,#2563eb,#0ea5e9)', boxShadow: '0 10px 28px rgba(37,99,235,0.28)' }}>
              Launch Dashboard <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="py-10" style={{ borderTop: '1px solid #bae6fd' }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <div className="flex items-center gap-2.5">
            <img src={logo} alt="Extips Panel Pro" className="h-6 w-6 rounded object-cover" />
            <span>© {new Date().getFullYear()} Extips Panel Pro · v3.0</span>
          </div>
          <div className="flex items-center gap-6">
            <Link to="/legal/terms" className="hover:text-slate-800 transition-colors">Terms</Link>
            <Link to="/legal/privacy" className="hover:text-slate-800 transition-colors">Privacy</Link>
            <Link to="/support" className="hover:text-slate-800 transition-colors">Support</Link>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Index;
