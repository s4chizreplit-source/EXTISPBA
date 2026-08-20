import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Rocket, Droplets, Sparkles, Wallet, Code2,
  LifeBuoy, Settings, Shield, LogOut, MoreHorizontal, X, History,
  Instagram, Grid3x3, Send
} from 'lucide-react';
import logo from '@/assets/logo.jpg';
import { useAuth } from '@/hooks/useAuth';
import { useCurrency } from '@/hooks/useCurrency';
import { cn } from '@/lib/utils';

const primary = [
  { icon: LayoutDashboard, label: 'Home', path: '/dashboard' },
  { icon: Instagram, label: 'Accounts', path: '/instagram' },
  { icon: Rocket, label: 'Engage', path: '/engagement-order' },
  { icon: Wallet, label: 'Wallet', path: '/wallet' },
];

const more = [
  { icon: Instagram, label: 'Instagram', path: '/instagram' },
  { icon: Send, label: 'Telegram Bot', path: '/telegram-bot' },
  { icon: Droplets, label: 'Mass Order', path: '/mass-order' },
  { icon: Sparkles, label: 'Engagement Orders', path: '/engagement-orders' },
  { icon: LifeBuoy, label: 'Support', path: '/support' },
  { icon: Settings, label: 'Settings', path: '/settings' },
];

export function MobileBottomNav() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const { isAdmin, signOut, wallet, profile } = useAuth();
  const { formatPrice } = useCurrency();

  const isActive = (p: string) => location.pathname === p;

  return (
    <>
      {/* Top header — all viewports */}
      <header className="fixed top-0 left-0 right-0 z-40">
        <div className="flex items-center justify-between h-14 px-3 sm:px-5 bg-[#f5f9ff]/85 backdrop-blur-md border-b border-border">
          <Link to="/dashboard" className="flex items-center gap-2 min-w-0">
            <img src={logo} alt="Extips Panel Pro" className="w-8 h-8 rounded-lg object-cover ring-1 ring-border shrink-0" />
            <div className="flex flex-col min-w-0">
              <span className="text-[14px] font-bold tracking-tight leading-tight !text-foreground truncate">Extips Panel Pro</span>
              <span className="text-[8px] font-semibold uppercase tracking-[0.18em] leading-tight text-primary/80">✦ v2.0</span>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <Link to="/wallet" className="flex items-center gap-1.5 h-9 px-3 rounded-xl bg-gradient-to-b from-primary/25 to-white/[0.02] border border-primary/30 text-[12px] font-semibold !text-foreground shadow-[0_0_18px_rgba(168,85,247,0.15)]">
              <Wallet className="w-3.5 h-3.5 text-primary" />
              <span className="tabular-nums">{formatPrice(wallet?.balance || 0)}</span>
            </Link>
            <button onClick={() => setOpen(true)} className="flex items-center justify-center w-9 h-9 rounded-xl border border-border text-muted-foreground hover:text-foreground hover:bg-card">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      {/* Bottom nav — all viewports */}
      <nav className="fixed bottom-0 left-0 right-0 z-40">
        <div className="w-full px-0 pb-[env(safe-area-inset-bottom)] pt-0">
          <div className="grid grid-cols-5 gap-1 rounded-none bg-[#ffffff]/95 backdrop-blur-xl border-t border-border shadow-[0_-10px_40px_rgba(0,0,0,0.6)] px-2 py-2">
            {primary.map((item) => {
              const active = isActive(item.path);
              return (
                <Link key={item.path} to={item.path}
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 py-1.5 rounded-xl transition-all',
                    active ? 'bg-card text-white' : 'text-muted-foreground hover:text-foreground hover:bg-card'
                  )}>
                  <item.icon className={cn('w-[18px] h-[18px]', active && 'text-primary')} />
                  <span className="text-[10px] font-semibold tracking-tight">{item.label}</span>
                </Link>
              );
            })}
            <button onClick={() => setOpen(true)}
              className="flex flex-col items-center justify-center gap-1 py-1.5 rounded-xl text-muted-foreground hover:text-foreground hover:bg-card transition-all">
              <MoreHorizontal className="w-[18px] h-[18px]" />
              <span className="text-[10px] font-semibold tracking-tight">More</span>
            </button>
          </div>
        </div>
      </nav>

      {/* More sheet */}
      {open && (
        <>
          <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="fixed bottom-0 left-0 right-0 z-50 max-h-[88vh] overflow-y-auto rounded-t-3xl bg-[#ffffff]/98 backdrop-blur-xl border-t border-border pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="sticky top-0 flex items-center justify-between px-5 py-3 border-b border-border bg-[#ffffff]/98">
              <span className="text-[13px] font-bold !text-foreground">Menu</span>
              <button onClick={() => setOpen(false)} className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card">
                <X className="w-4 h-4" />
              </button>
            </div>

            {profile && (
              <div className="mx-4 mt-4 flex items-center gap-3 px-3 py-3 rounded-2xl bg-card border border-border">
                <div className="w-10 h-10 rounded-full flex items-center justify-center text-[13px] font-bold !text-foreground shrink-0 bg-gradient-to-br from-primary to-primary">
                  {profile.full_name?.[0]?.toUpperCase() || 'U'}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold truncate !text-foreground">{profile.full_name || 'User'}</p>
                  <p className="text-[11px] truncate text-muted-foreground">{profile.email}</p>
                </div>
              </div>
            )}

            <div className="p-3 grid grid-cols-2 gap-2">
              {more.map((item) => {
                const active = isActive(item.path);
                return (
                  <Link key={item.path} to={item.path} onClick={() => setOpen(false)}
                    className={cn(
                      'flex items-center gap-2.5 px-3 py-3 rounded-xl text-[13px] border transition-all',
                      active ? 'bg-card border-border text-white font-semibold' : 'border-border bg-card text-muted-foreground hover:text-foreground hover:bg-card'
                    )}>
                    <item.icon className={cn('w-4 h-4', active ? 'text-primary' : 'text-muted-foreground')} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
              {isAdmin && (
                <Link to="/admin" onClick={() => setOpen(false)}
                  className="col-span-2 flex items-center gap-2.5 px-3 py-3 rounded-xl text-[13px] font-semibold bg-primary/10 border border-primary/30 text-primary">
                  <Shield className="w-4 h-4" />
                  <span>Admin Panel</span>
                </Link>
              )}
            </div>

            <div className="px-4 pb-2">
              <a href="https://t.me/whopcampaign" target="_blank" rel="noopener noreferrer"
                className="w-full flex items-center gap-2.5 px-3 py-3 rounded-xl text-[12px] font-medium bg-sky-500/10 border border-sky-400/20 text-sky-200">
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
                <div className="flex flex-col text-left">
                  <span className="font-semibold text-[12px]">Join our Telegram</span>
                  <span className="text-[10px] text-sky-200/60">Updates & support</span>
                </div>
              </a>
            </div>

            <div className="px-4 pt-2">
              <button onClick={() => { setOpen(false); signOut(); }}
                className="w-full flex items-center justify-center gap-2 px-3 py-3 rounded-xl text-[13px] font-semibold text-red-300 bg-red-500/10 border border-red-400/20 hover:bg-red-500/15">
                <LogOut className="w-4 h-4" />
                Sign out
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
