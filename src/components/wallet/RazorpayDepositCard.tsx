import { Send, MessageCircle, Wallet as WalletIcon, Clock, ShieldCheck } from 'lucide-react';
import supportAvatar from '@/assets/logo.png';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';

// 🚨 Razorpay/WazirX temporarily suspended.
// Users must contact support directly on Telegram or WhatsApp to add funds.
const TELEGRAM_USERNAME = 'Organicsmmcashier';
const TELEGRAM_URL = `https://t.me/${TELEGRAM_USERNAME}`;
const WHATSAPP_NUMBER = '255637520201'; // +255 637 520 201

function buildSupportMessage(email?: string) {
  return (
    `Hi! 👋\n\n` +
    `Mujhe apne Extips Panel Pro wallet me funds add karne hain.\n` +
    (email ? `My account email: ${email}\n` : '') +
    `\nPlease help me with the payment process. 🙏`
  );
}

export default function RazorpayDepositCard() {
  const { user, profile } = useAuth();
  const userEmail = profile?.email || user?.email || '';
  const message = buildSupportMessage(userEmail);
  const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

  const handleTelegramClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Telegram personal chats don't support URL-prefilled text.
    // Workaround: copy the message to clipboard, then open the chat.
    try {
      await navigator.clipboard.writeText(message);
      toast.success('📋 Message copied! Telegram me paste kar dena.', { duration: 4000 });
    } catch {
      toast.info('Telegram khul raha hai — apna message type kar dena.');
    }
    // let the default <a target="_blank"> navigation continue
  };

  return (
    <div className="max-w-lg mx-auto">
      <div
        className="rounded-2xl overflow-hidden relative"
        style={{
          background: 'linear-gradient(180deg, #ffffff, #fafbfc)',
          border: '1px solid rgba(220,38,38,.18)',
          boxShadow: '0 8px 32px rgba(220,38,38,.08), 0 2px 8px rgba(0,0,0,.04)',
        }}
      >
        {/* Top gradient strip */}
        <div
          className="h-1.5"
          style={{ background: 'linear-gradient(90deg, #dc2626, #ffffff, #dc2626)' }}
        />

        {/* Header */}
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3">
            <div
              className="w-11 h-11 rounded-2xl flex items-center justify-center"
              style={{
                background: 'linear-gradient(135deg, #ffffff, #e9eefb)',
                boxShadow: '0 4px 12px rgba(0,0,0,.25)',
              }}
            >
              <WalletIcon className="h-5 w-5 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[18px] font-bold" style={{ color: '#eef4ff' }}>
                💰 Add Funds — Manual
              </h2>
              <p className="text-[12px] mt-0.5" style={{ color: '#888' }}>
                Direct contact support to add funds instantly.
              </p>
            </div>
          </div>
        </div>

        {/* Suspension Notice */}
        <div className="px-6 pb-4">
          <div
            className="rounded-xl p-3 flex items-start gap-2"
            style={{ background: 'rgba(245,158,11,.08)', border: '1px solid rgba(245,158,11,.2)' }}
          >
            <Clock className="h-4 w-4 flex-shrink-0 mt-0.5" style={{ color: '#b45309' }} />
            <p className="text-[11.5px] leading-relaxed" style={{ color: '#92400e' }}>
              <b>Auto payment gateway temporarily unavailable.</b> Funds add karne ke liye
              niche diye Telegram ya WhatsApp se direct contact karein — instant manual credit.
            </p>
          </div>
        </div>

        {/* Support Card with photo */}
        <div className="px-6 pb-5">
          <div
            className="rounded-2xl overflow-hidden relative"
            style={{
              background: 'linear-gradient(135deg, #ffffff, #ffffff)',
              border: '1px solid rgba(220,38,38,.35)',
              boxShadow: '0 10px 28px rgba(0,0,0,.35), inset 0 1px 0 rgba(255,255,255,.05)',
            }}
          >
            {/* red glow accents */}
            <div
              className="absolute -top-12 -right-12 w-40 h-40 rounded-full pointer-events-none"
              style={{ background: 'radial-gradient(circle, rgba(220,38,38,.35), transparent 70%)' }}
            />
            <div
              className="absolute -bottom-12 -left-12 w-40 h-40 rounded-full pointer-events-none"
              style={{ background: 'radial-gradient(circle, rgba(220,38,38,.25), transparent 70%)' }}
            />

            <div className="relative p-5 flex flex-col items-center text-center">
              {/* Avatar */}
              <div
                className="w-24 h-24 rounded-2xl overflow-hidden mb-3"
                style={{
                  border: '2px solid rgba(220,38,38,.6)',
                  boxShadow: '0 0 30px rgba(220,38,38,.35), 0 6px 16px rgba(0,0,0,.5)',
                }}
              >
                <img
                  src={supportAvatar}
                  alt="Support"
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
              </div>

              <p className="text-[13px] font-bold tracking-wide text-white">
                💬 Talk to Support
              </p>
              <p className="text-[11px] mt-1 mb-4" style={{ color: '#64748b' }}>
                24/7 available — instant fund add karwa lo
              </p>

              {/* Buttons */}
              <div className="w-full flex flex-col gap-2.5">
                <a
                  href={TELEGRAM_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={handleTelegramClick}
                  className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-bold transition-all hover:scale-[1.02]"
                  style={{
                    background: 'linear-gradient(135deg, #229ED9, #1d8bc0)',
                    color: '#fff',
                    boxShadow: '0 6px 18px rgba(34,158,217,.4)',
                  }}
                >
                  <Send className="h-4 w-4" />
                  Contact on Telegram
                </a>

                <a
                  href={whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 rounded-xl py-3 text-[13px] font-bold transition-all hover:scale-[1.02]"
                  style={{
                    background: 'linear-gradient(135deg, #25D366, #1ebe57)',
                    color: '#fff',
                    boxShadow: '0 6px 18px rgba(37,211,102,.4)',
                  }}
                >
                  <MessageCircle className="h-4 w-4" />
                  Contact on WhatsApp
                </a>
              </div>

              <p className="text-[10px] mt-4 leading-relaxed" style={{ color: '#64748b' }}>
                Telegram pe click karte hi message <b style={{ color: '#fff' }}>auto-copy</b> ho
                jayega — chat me sirf paste karke send karna.
              </p>
            </div>
          </div>
        </div>

        {/* Trust badges */}
        <div className="px-6 pb-5">
          <div className="grid grid-cols-3 gap-2">
            {[
              { icon: '⚡', label: 'Instant Credit' },
              { icon: '🛡️', label: 'Safe & Trusted' },
              { icon: '🕒', label: '24/7 Support' },
            ].map((b) => (
              <div
                key={b.label}
                className="rounded-xl py-2.5 px-2 text-center"
                style={{ background: 'rgba(220,38,38,.05)', border: '1px solid rgba(220,38,38,.12)' }}
              >
                <div className="text-[16px] leading-none mb-1">{b.icon}</div>
                <p className="text-[10px] font-semibold" style={{ color: '#dc2626' }}>
                  {b.label}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Footer */}
        <div
          className="px-6 py-3 flex items-center justify-center gap-2"
          style={{ borderTop: '1px solid rgba(0,0,0,.04)', background: 'rgba(0,0,0,.015)' }}
        >
          <ShieldCheck className="h-3.5 w-3.5" style={{ color: '#888' }} />
          <span className="text-[11px] font-medium" style={{ color: '#888' }}>
            Verified manual deposit • Trusted by 1000+ users
          </span>
        </div>
      </div>
    </div>
  );
}
