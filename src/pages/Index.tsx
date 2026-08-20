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
 * Extips Panel Pro — Software-style landing (Violet Aurora).
 * Dark canvas, fine grid, violet aurora glows, display headline with serif italic accent.
 */

const Index = () => {
  const { user } = useAuth();


  return (
    <div className="min-h-screen w-full bg-background text-foreground overflow-x-hidden antialiased">
      <PageMeta
        title="Extips Panel Pro — The Growth Engine for Social Magic"
        description="Precision-engineered organic engagement for Instagram, TikTok and YouTube. Multi-provider failover, wallet, live dashboard."
        canonicalPath="/"
        breadcrumbs={[{ name: 'Home', path: '/' }]}
      />

      {/* Global ambient layers */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        {/* Grid */}
        <div
          className="absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              'linear-gradient(#475569 1px, transparent 1px), linear-gradient(90deg, #475569 1px, transparent 1px)',
            backgroundSize: '44px 44px',
            maskImage:
              'radial-gradient(ellipse at center, black 40%, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse at center, black 40%, transparent 80%)',
          }}
        />
        {/* Aurora */}
        <div className="absolute top-[-15%] left-1/2 -translate-x-1/2 w-[900px] h-[480px] bg-primary/25 blur-[140px] rounded-full" />
        <div className="absolute top-[20%] right-[-10%] w-[480px] h-[480px] bg-accent/15 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[520px] h-[520px] bg-primary/15 blur-[140px] rounded-full" />
      </div>

      {/* Nav */}
      <header className="sticky top-0 z-40 backdrop-blur-md bg-background/70 border-b border-border">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5">
            <img src={logo} alt="Extips Panel Pro" width={32} height={32} fetchPriority="high" decoding="async" className="h-8 w-8 rounded-md object-cover ring-1 ring-border" />
            <span className="text-[15px] font-semibold tracking-tight">Extips Panel Pro</span>
            <span className="hidden sm:inline text-[10px] uppercase tracking-[0.18em] text-muted-foreground ml-2 px-1.5 py-0.5 rounded border border-border">v2</span>
          </Link>

          <nav className="hidden md:flex items-center gap-8 text-sm text-muted-foreground">
            <a href="#features" className="hover:text-foreground transition-colors">Features</a>
            <a href="#platforms" className="hover:text-foreground transition-colors">Platforms</a>
            <Link to="/support" className="hover:text-foreground transition-colors">Support</Link>
          </nav>

          <div className="flex items-center gap-2.5">
            <Link
              to="/auth"
              className="hidden sm:inline-flex text-sm text-muted-foreground hover:text-foreground px-3 py-2 rounded-lg transition-colors"
            >
              Sign in
            </Link>
            <Link
              to="/auth"
              className="inline-flex items-center gap-1.5 text-sm font-semibold px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-all shadow-[0_10px_24px_rgba(29,78,216,0.25)] active:scale-[0.98]"
            >
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
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full border border-border bg-card backdrop-blur-sm mb-8">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-75 animate-ping" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary" />
            </span>
            <span className="text-[11px] font-medium tracking-[0.18em] uppercase text-primary/70">
              Extips Panel Pro Software v2.0
            </span>
          </div>

          {/* Headline */}
          <h1
            className="!text-foreground text-5xl sm:text-7xl lg:text-[88px] font-extrabold tracking-tight leading-[1.02] mb-6"
            style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
          >
            The Growth Engine
            <br />
            for Social{' '}
            <span
              className="italic font-bold text-primary"
              style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
            >
              Magic
            </span>
          </h1>

          {/* Sub */}
          <p className="text-base sm:text-xl text-slate-200 max-w-2xl mx-auto mb-10 leading-relaxed">
            Master Instagram, TikTok, and YouTube organic engagement through a
            precision-engineered platform. No bots — just high-performance
            software with multi-provider failover, wallet, and a live dashboard.
          </p>

          {/* CTA */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
            <Link
              to="/auth"
              className="w-full sm:w-auto inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-all shadow-[0_10px_24px_rgba(29,78,216,0.25)] active:scale-[0.98]"
            >
              Launch Dashboard <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/wallet"
              className="w-full sm:w-auto inline-flex items-center justify-center px-7 py-3.5 bg-card border border-border text-white font-semibold rounded-xl hover:bg-card transition-all backdrop-blur-md"
            >
              Add funds
            </Link>
          </div>

          {/* Platforms strip */}
          <div className="mt-20 pt-8 border-t border-border">
            <p className="text-[10px] tracking-[0.24em] uppercase text-muted-foreground mb-5">
              Built for the platforms that matter
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-muted-foreground">
              {[
                { Icon: Instagram, label: 'INSTAGRAM' },
                { Icon: Sparkles, label: 'TIKTOK' },
                { Icon: Youtube, label: 'YOUTUBE' },
                { Icon: MessageCircle, label: 'TELEGRAM' },
                { Icon: Globe, label: 'FACEBOOK' },
              ].map(({ Icon, label }) => (
                <div key={label} className="flex items-center gap-2 hover:text-foreground/80 transition-colors">
                  <Icon className="h-4 w-4" />
                  <span className="text-xs font-semibold tracking-[0.18em]">{label}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative py-24 sm:py-32 border-t border-border">
        <div className="max-w-6xl mx-auto px-5 sm:px-8">
          <div className="max-w-2xl mb-14">
            <p className="text-[11px] tracking-[0.22em] uppercase text-primary/70 mb-4">
              The Software
            </p>
            <h2 className="!text-foreground text-3xl sm:text-5xl font-bold tracking-tight leading-[1.1]">
              Engineered like infrastructure,
              <br />
              <span
                className="italic text-primary"
                style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
              >
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
              <div
                key={title}
                className="group relative rounded-2xl border border-border bg-card p-6 hover:bg-card hover:border-border transition-all backdrop-blur-sm"
              >
                <div className="h-10 w-10 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center mb-5">
                  <Icon className="h-5 w-5 text-primary" />
                </div>
                <h3 className="text-base font-semibold mb-2">{title}</h3>
                <p className="text-sm text-slate-200 leading-relaxed">{body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Platforms */}
      <section id="platforms" className="relative py-24 border-t border-border">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-[11px] tracking-[0.22em] uppercase text-primary/70 mb-4">
              Cross-platform
            </p>
            <h2 className="!text-foreground text-3xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5">
              One control room for{' '}
              <span
                className="italic text-primary"
                style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
              >
                every channel.
              </span>
            </h2>
            <p className="text-slate-200 leading-relaxed mb-8 max-w-lg">
              Plug in a URL, pick a bundle, hit launch. Extips Panel Pro handles the
              routing, the dispatch, and the retries — so you don't have to
              babysit any of it.
            </p>
            <ul className="space-y-3">
              {[
                'Instagram followers, likes, views & reels',
                'TikTok views, hearts & followers',
                'YouTube views, subs & engagement',
                'Telegram, Facebook, X — all routed',
              ].map((t) => (
                <li key={t} className="flex items-center gap-3 text-sm text-slate-100">
                  <span className="h-5 w-5 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center shrink-0">
                    <Check className="h-3 w-3 text-primary" />
                  </span>
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative">
            <div className="absolute -inset-6 bg-primary/20 blur-[80px] rounded-full" />
            <div className="relative rounded-2xl border border-border bg-card p-6 backdrop-blur-md shadow-[0_20px_60px_-24px_rgba(20,50,110,0.18)]">
              <div className="flex items-center gap-1.5 mb-5">
                <span className="h-2.5 w-2.5 rounded-full bg-card" />
                <span className="h-2.5 w-2.5 rounded-full bg-card" />
                <span className="h-2.5 w-2.5 rounded-full bg-card" />
                <span className="ml-auto text-[10px] uppercase tracking-[0.18em] text-muted-foreground">extipspanel.live</span>
              </div>
              <div className="space-y-3">
                {[
                  { p: 'Instagram', t: 'Reel views', q: '12,500', s: 'Running' },
                  { p: 'TikTok', t: 'Hearts', q: '4,200', s: 'Queued' },
                  { p: 'YouTube', t: 'Subscribers', q: '850', s: 'Complete' },
                  { p: 'Instagram', t: 'Followers', q: '2,000', s: 'Running' },
                ].map((r, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg border border-border bg-card px-3.5 py-3">
                    <div>
                      <div className="text-[10px] uppercase tracking-widest text-muted-foreground mb-0.5">{r.p}</div>
                      <div className="text-sm font-medium">{r.t}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold">{r.q}</div>
                      <div className={`text-[10px] uppercase tracking-widest ${r.s === 'Complete' ? 'text-emerald-300/80' : r.s === 'Queued' ? 'text-amber-300/80' : 'text-primary/80'}`}>
                        {r.s}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="relative py-24 border-t border-border">
        <div className="max-w-4xl mx-auto px-5 sm:px-8 text-center">
          <h2 className="!text-foreground text-3xl sm:text-5xl font-bold tracking-tight leading-[1.1] mb-5">
            Ready to ship{' '}
            <span
              className="italic text-primary"
              style={{ fontFamily: "'Playfair Display', Georgia, serif" }}
            >
              real growth?
            </span>
          </h2>
          <p className="text-slate-200 max-w-xl mx-auto mb-8">
            Skip the panel templates. Run growth like software.
          </p>
          <Link
            to="/auth"
            className="inline-flex items-center justify-center gap-2 px-7 py-3.5 bg-primary text-primary-foreground font-semibold rounded-xl hover:bg-primary/90 transition-all shadow-[0_10px_24px_rgba(29,78,216,0.25)] active:scale-[0.98]"
          >
            Launch Dashboard <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-border py-10">
        <div className="max-w-6xl mx-auto px-5 sm:px-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-sm text-muted-foreground">
          <div className="flex items-center gap-2.5">
            <img src={logo} alt="Extips Panel Pro" className="h-6 w-6 rounded object-cover ring-1 ring-border" />
            <span>© {new Date().getFullYear()} Extips Panel Pro. All rights reserved.</span>
          </div>
          <div className="flex items-center gap-6">
            <Link to="/legal/terms" className="hover:text-foreground/70">Terms</Link>
            <Link to="/legal/privacy" className="hover:text-foreground/70">Privacy</Link>
            <Link to="/support" className="hover:text-foreground/70">Support</Link>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default Index;
