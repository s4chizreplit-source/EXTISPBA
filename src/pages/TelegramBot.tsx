import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  BellRing,
  Bot,
  Clock3,
  MessageCircleMore,
  Rocket,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  WalletCards,
} from "lucide-react";
import { Link } from "react-router-dom";

const UPCOMING_FEATURES = [
  {
    icon: Rocket,
    title: "Place Orders",
    description: "Instagram links par views, likes aur comments ke orders Telegram se place karein.",
  },
  {
    icon: WalletCards,
    title: "Wallet Balance",
    description: "Apna live wallet balance aur recent transactions turant check karein.",
  },
  {
    icon: BellRing,
    title: "Live Order Updates",
    description: "Processing, completed aur failed orders ki instant notifications paayein.",
  },
  {
    icon: MessageCircleMore,
    title: "Manage Instagram Posts",
    description: "Recent posts dekhein aur Telegram ke andar se quick boost apply karein.",
  },
  {
    icon: Settings2,
    title: "Auto Order Presets",
    description: "Default quantity aur auto/manual mode ko simple commands se control karein.",
  },
  {
    icon: ShieldCheck,
    title: "Secure Account Linking",
    description: "One-time verification ke saath apna EXTIPS account safely connect karein.",
  },
];

export default function TelegramBot() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-5 sm:px-6 sm:py-8 pb-24">
      <header className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2 text-sm font-semibold text-muted-foreground">
          <Send className="h-4 w-4 text-primary" /> Telegram Bot
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/dashboard"><ArrowLeft className="w-4 h-4 mr-1" /> Home</Link>
        </Button>
      </header>

      <section className="relative overflow-hidden rounded-2xl border border-primary/20 bg-card px-5 py-10 text-center shadow-soft sm:px-10 sm:py-14">
        <div className="absolute inset-x-0 top-0 h-1 bg-primary" />
        <div className="mx-auto mb-5 flex h-20 w-20 items-center justify-center rounded-full border border-primary/20 bg-primary/10 text-primary shadow-glow">
          <Bot className="h-10 w-10" />
        </div>
        <Badge variant="outline" className="mb-4 border-primary/30 bg-primary/5 text-primary">
          <Clock3 className="mr-1.5 h-3.5 w-3.5" /> In Development
        </Badge>
        <h1 className="text-3xl font-extrabold sm:text-5xl">Telegram Bot Coming Soon</h1>
        <p className="mx-auto mt-4 max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
          EXTIPS Panel ko Telegram se manage karna aur bhi fast hone wala hai. Hamari team ek secure aur powerful bot experience tayyar kar rahi hai.
        </p>
        <div className="mx-auto mt-6 flex w-fit items-center gap-2 rounded-full border border-border bg-secondary px-4 py-2 text-xs font-semibold text-secondary-foreground sm:text-sm">
          <Sparkles className="h-4 w-4 text-primary" /> Launch update aapko dashboard par mil jayega
        </div>
      </section>

      <section className="mt-9" aria-labelledby="upcoming-features">
        <div className="mb-5 text-center">
          <h2 id="upcoming-features" className="text-2xl font-extrabold">What&apos;s Coming</h2>
          <p className="mt-1 text-sm text-muted-foreground">Telegram par milne wale powerful features</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {UPCOMING_FEATURES.map(({ icon: Icon, title, description }) => (
            <Card key={title} className="border-border bg-card transition-colors hover:border-primary/30">
              <CardContent className="p-5">
                <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" />
                </div>
                <h3 className="text-base font-bold">{title}</h3>
                <p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <section className="mt-7 rounded-xl border border-border bg-secondary/60 px-5 py-4 sm:flex sm:items-center sm:justify-between sm:gap-5">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 text-primary">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-sm font-bold">Safe & Reliable Experience</h2>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Bot ko public launch se pehle security aur order reliability ke liye thoroughly test kiya ja raha hai.
            </p>
          </div>
        </div>
        <Badge variant="secondary" className="mt-3 whitespace-nowrap sm:mt-0">Stay Tuned</Badge>
      </section>
    </main>
  );
}
