import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Mail, Loader2, ArrowLeft, Eye, EyeOff, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { z } from 'zod';
import logo from '@/assets/logo.jpg';
import { PageMeta } from '@/components/seo/PageMeta';

const loginSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(512, 'Password is too long'),
});

const signupSchema = z.object({
  email: z.string().trim().email('Please enter a valid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(512, 'Password is too long (max 512 characters)'),
  fullName: z.string().trim().min(2, 'Name must be at least 2 characters').max(120, 'Name is too long'),
});

export default function Auth() {
  const [isLogin, setIsLogin] = useState(true);
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [showVerifyEmail, setShowVerifyEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const { signIn, signUp, user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Preserve `next` (e.g. OAuth consent URL) as a same-origin relative path only.
  const rawNext = searchParams.get('next') || '';
  const nextPath = rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '';
  const postAuthTarget = nextPath || '/engagement-order';

  useEffect(() => {
    if (!isLoading && user) navigate(postAuthTarget, { replace: true });
  }, [user, isLoading, navigate, postAuthTarget]);

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccessMessage(''); setIsSubmitting(true);
    try {
      const trimmedEmail = email.trim().toLowerCase();
      if (!trimmedEmail || !z.string().email().safeParse(trimmedEmail).success) {
        setError('Please enter a valid email address'); setIsSubmitting(false); return;
      }
      const { error } = await supabase.auth.resetPasswordForEmail(trimmedEmail, { redirectTo: `${window.location.origin}/auth` });
      if (error) setError(error.message); else setSuccessMessage('Password reset email sent! Check your inbox.');
    } catch { setError('Something went wrong.'); }
    finally { setIsSubmitting(false); }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(''); setSuccessMessage(''); setIsSubmitting(true);
    try {
      if (isLogin) {
        const v = loginSchema.safeParse({ email, password });
        if (!v.success) { setError(v.error.errors[0].message); setIsSubmitting(false); return; }
        const { error } = await signIn(email, password);
        if (error) {
          const raw = (error.message || '').trim();
          const msg = raw.toLowerCase();
          const isEmpty = !raw || raw === '{}' || raw === '[object Object]';
          if (msg.includes('invalid login credentials') || msg.includes('invalid_credentials')) setError('Incorrect email or password. Please try again.');
          else if (msg.includes('email not confirmed')) setError('Please verify your email first, or sign up again.');
          else if (msg.includes('rate limit') || msg.includes('too many')) setError('Too many attempts. Please wait a few minutes and try again.');
          else if (msg.includes('user not found') || msg.includes('no user')) setError('No account found with this email. Please sign up first.');
          else if (isEmpty || msg.includes('unexpected') || msg.includes('database error')) setError('Sign-in service error. Please try again in a moment or contact support.');
          else setError(raw);
          setIsSubmitting(false); return;
        }

        navigate(postAuthTarget, { replace: true });
      } else {
        const v = signupSchema.safeParse({ email, password, fullName });
        if (!v.success) { setError(v.error.errors[0].message); setIsSubmitting(false); return; }
        const { error } = await signUp(email, password, fullName);
        if (error) {
          // Show the real reason from the backend instead of a generic message.
          setError(error.message || 'Unable to create your account. Please try again.');
          setIsSubmitting(false); return;
        }
        setSuccessMessage('Account created successfully! Signing you in…');
      }
    } catch (err: any) {
      if (!err?.message?.includes('abort')) setError('Something went wrong. Please try again.');
    } finally { setIsSubmitting(false); }
  };

  const inputClass = "h-12 rounded-xl bg-card border border-border focus:border-primary/60 focus:ring-1 focus:ring-primary/40 !text-foreground font-medium px-4 placeholder:text-muted-foreground transition-all";

  return (
    <div className="min-h-screen w-full bg-white text-foreground overflow-x-hidden antialiased relative flex items-center justify-center px-5 py-12">
      <PageMeta
        title={isLogin ? 'Sign in — Extips Panel Pro' : 'Create your account — Extips Panel Pro'}
        description="Sign in or create your free Extips Panel Pro account to launch organic Instagram, YouTube and TikTok growth campaigns. No credit card required."
        canonicalPath="/auth"
      />

      {/* Ambient layers */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10">
        <div
          className="absolute inset-0 opacity-[0.12]"
          style={{
            backgroundImage:
              'linear-gradient(#475569 1px, transparent 1px), linear-gradient(90deg, #475569 1px, transparent 1px)',
            backgroundSize: '44px 44px',
            maskImage: 'radial-gradient(ellipse at center, black 40%, transparent 80%)',
            WebkitMaskImage: 'radial-gradient(ellipse at center, black 40%, transparent 80%)',
          }}
        />
        <div className="absolute top-[-15%] left-1/2 -translate-x-1/2 w-[900px] h-[480px] bg-primary/30 blur-[140px] rounded-full" />
        <div className="absolute bottom-[-20%] left-[-10%] w-[520px] h-[520px] bg-primary/15 blur-[140px] rounded-full" />
        <div className="absolute top-[30%] right-[-10%] w-[420px] h-[420px] bg-primary/15 blur-[120px] rounded-full" />
      </div>

      <div className="w-full max-w-[420px] relative">
        <Link to="/" className="inline-flex items-center gap-1.5 text-[12px] font-medium mb-8 text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="w-3.5 h-3.5" /> Back to home
        </Link>

        {/* Logo */}
        <div className="flex items-center gap-2.5 mb-10">
          <img src={logo} alt="Extips Panel Pro" className="w-10 h-10 rounded-xl object-cover ring-1 ring-border" />
          <div className="flex flex-col">
            <span className="text-[16px] font-bold tracking-tight !text-foreground">Extips Panel Pro</span>
            <span className="text-[9px] font-semibold uppercase tracking-[0.18em] text-primary/80">✦ v2.0</span>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card backdrop-blur-md p-7 shadow-[0_20px_60px_-24px_rgba(20,50,110,0.18)]">
          <h1
            className="!text-foreground text-3xl font-extrabold tracking-tight mb-1.5"
            style={{ fontFamily: "'Inter', system-ui, sans-serif" }}
          >
            {isForgotPassword ? (
              <>Reset <span className="italic text-primary" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>password</span></>
            ) : isLogin ? (
              <>Welcome <span className="italic text-primary" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>back</span></>
            ) : (
              <>Create <span className="italic text-primary" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>account</span></>
            )}
          </h1>
          <p className="text-[13px] mb-7 text-muted-foreground">
            {isForgotPassword ? 'Enter your email to receive a reset link.' : isLogin ? 'Sign in to your dashboard.' : 'Get started in seconds.'}
          </p>

          {showVerifyEmail ? (
            <div className="text-center py-6">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-6 bg-primary/15 border border-primary/30">
                <Mail className="w-7 h-7 text-primary" />
              </div>
              <h3 className="text-xl font-bold mb-2 !text-foreground">Check your inbox</h3>
              <p className="text-[13px] mb-2 text-muted-foreground">Verification link sent to:</p>
              <p className="text-[13px] font-semibold mb-6 !text-foreground">{email}</p>
              <button onClick={() => { setShowVerifyEmail(false); setIsLogin(true); }} className="text-[13px] font-semibold text-primary hover:text-primary">
                ← Back to login
              </button>
            </div>
          ) : (
            <form onSubmit={isForgotPassword ? handleForgotPassword : handleSubmit} className="space-y-4">
              {isForgotPassword ? (
                <div className="space-y-4">
                  <div>
                    <Label className="text-[12px] font-semibold mb-1.5 block text-muted-foreground" style={{ textTransform: 'none', letterSpacing: 'normal' }}>Email</Label>
                    <Input type="email" placeholder="name@example.com" value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
                  </div>
                  {error && <p className="text-[13px] font-medium text-red-400">{error}</p>}
                  {successMessage && <p className="text-[13px] font-medium text-emerald-300">{successMessage}</p>}
                  <button type="submit" disabled={isSubmitting} className="w-full h-11 rounded-xl text-[13px] font-semibold text-primary-foreground bg-primary hover:bg-primary transition-all shadow-[0_10px_24px_rgba(29,78,216,0.25)] active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-70">
                    {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Send reset link <ArrowRight className="w-3.5 h-3.5" /></>}
                  </button>
                  <button type="button" onClick={() => setIsForgotPassword(false)} className="w-full text-center text-[13px] font-medium text-muted-foreground hover:text-foreground">
                    Back to login
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {!isLogin && (
                    <div>
                      <Label className="text-[12px] font-semibold mb-1.5 block text-muted-foreground" style={{ textTransform: 'none', letterSpacing: 'normal' }}>Full name</Label>
                      <Input placeholder="John Doe" value={fullName} onChange={e => setFullName(e.target.value)} className={inputClass} />
                    </div>
                  )}
                  <div>
                    <Label className="text-[12px] font-semibold mb-1.5 block text-muted-foreground" style={{ textTransform: 'none', letterSpacing: 'normal' }}>Email</Label>
                    <Input type="email" placeholder="name@example.com" value={email} onChange={e => setEmail(e.target.value)} className={inputClass} />
                  </div>
                  <div>
                    <div className="flex items-center justify-between mb-1.5">
                      <Label className="text-[12px] font-semibold text-muted-foreground" style={{ textTransform: 'none', letterSpacing: 'normal' }}>Password</Label>
                      {isLogin && (
                        <button type="button" onClick={() => setIsForgotPassword(true)} className="text-[11px] font-medium text-primary hover:text-primary">
                          Forgot password?
                        </button>
                      )}
                    </div>
                    <div className="relative">
                      <Input type={showPassword ? 'text' : 'password'} placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} className={`${inputClass} pr-11`} />
                      <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                  </div>

                  {error && <p className="text-[13px] font-medium text-red-400">{error}</p>}
                  {successMessage && <p className="text-[13px] font-medium text-emerald-300">{successMessage}</p>}

                  <button type="submit" disabled={isSubmitting} className="w-full h-11 rounded-xl text-[13px] font-semibold text-primary-foreground bg-primary hover:bg-primary transition-all shadow-[0_10px_24px_rgba(29,78,216,0.25)] active:scale-[0.98] flex items-center justify-center gap-2 disabled:opacity-70">
                    {isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <>{isLogin ? 'Sign in' : 'Create account'} <ArrowRight className="w-3.5 h-3.5" /></>}
                  </button>

                  <p className="text-center text-[13px] text-muted-foreground">
                    {isLogin ? "Don't have an account? " : 'Already have an account? '}
                    <button type="button" onClick={() => { setIsLogin(!isLogin); setError(''); setSuccessMessage(''); }} className="font-semibold text-primary hover:text-primary">
                      {isLogin ? 'Sign up' : 'Sign in'}
                    </button>
                  </p>
                </div>
              )}
            </form>
          )}
        </div>

        {/* Telegram */}
        <a href="https://t.me/whopcampaign" target="_blank" rel="noopener noreferrer" className="mt-5 flex items-center gap-3 p-3.5 rounded-xl border border-border bg-card hover:bg-card transition-colors">
          <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-sky-500/15 border border-sky-400/20">
            <svg className="w-4 h-4 fill-sky-300" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69.01-.03.01-.14-.07-.2-.08-.06-.19-.04-.27-.02-.11.02-1.93 1.23-5.46 3.62-.51.35-.98.53-1.39.52-.46-.01-1.33-.26-1.98-.48-.8-.27-1.43-.42-1.37-.89.03-.25.38-.51 1.03-.78 4.04-1.76 6.74-2.92 8.09-3.48 3.85-1.61.8-1.88 1.77-1.88.21 0 .69.05.99.23.32.19.43.46.46.72.02.16.01.32-.01.48z" /></svg>
          </div>
          <div>
            <p className="text-[12px] font-semibold !text-foreground">Join our Telegram</p>
            <p className="text-[11px] text-muted-foreground">Updates & support</p>
          </div>
        </a>
      </div>
    </div>
  );
}
