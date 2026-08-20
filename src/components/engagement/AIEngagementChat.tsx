import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Brain, Loader2, Send, Sparkles, AlertTriangle, ShieldCheck, Eye, Heart, MessageCircle } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { analyzeCounts, type RatioKey } from "@/lib/engagement-ratio";

interface PerTypeEntry { enabled: boolean; quantity: number }
interface Props {
  link: string;
  platform: string;
  engagements: Record<string, PerTypeEntry>;
  totalQuantity: number;
}

type ChatMsg = { role: "user" | "assistant"; content: string };

function detectPlatform(link: string): string {
  const l = (link || "").toLowerCase();
  if (l.includes("instagram.com")) return "Instagram";
  if (l.includes("tiktok.com")) return "TikTok";
  if (l.includes("youtube.com") || l.includes("youtu.be")) return "YouTube";
  if (l.includes("twitter.com") || l.includes("x.com")) return "X / Twitter";
  if (l.includes("facebook.com")) return "Facebook";
  return "Unknown";
}
function detectPostType(link: string): string {
  const l = (link || "").toLowerCase();
  if (l.includes("/reel")) return "Reel";
  if (l.includes("/p/")) return "Post";
  if (l.includes("/tv/")) return "IGTV";
  if (l.includes("/stories")) return "Story";
  if (l.includes("/shorts/")) return "Short";
  if (l.includes("watch?v=") || l.includes("youtu.be/")) return "Video";
  return "Post";
}

const RATIO_KEY_MAP: Record<string, RatioKey | "views" | "followers"> = {
  views: "views", impressions: "views", plays: "views", reach: "views",
  likes: "likes", reactions: "likes",
  comments: "comments",
  shares: "shares",
  saves: "saves", bookmarks: "saves",
  followers: "followers", subscribers: "followers",
};

export function AIEngagementChat({ link, platform, engagements, totalQuantity }: Props) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const perType = useMemo(() => {
    const acc: Record<string, number> = {};
    for (const [t, cfg] of Object.entries(engagements || {})) {
      if (!cfg?.enabled) continue;
      const bucket = RATIO_KEY_MAP[t.toLowerCase()];
      if (!bucket) continue;
      acc[bucket] = (acc[bucket] ?? 0) + (cfg.quantity || 0);
    }
    return acc;
  }, [engagements]);

  const report = useMemo(() => analyzeCounts(perType), [perType]);
  const detectedPlatform = link ? detectPlatform(link) : (platform || "—");
  const detectedPostType = link ? detectPostType(link) : "—";

  const linkOk = !!link && /^https?:\/\//i.test(link);

  // Auto-greet on open
  useEffect(() => {
    if (open && messages.length === 0) {
      const greet: string[] = [];
      if (linkOk) greet.push(`Got it — detected a ${detectedPlatform} ${detectedPostType}.`);
      else greet.push("Please paste your post link first so I can analyze it.");
      if (Object.keys(perType).length) {
        greet.push(`You've selected ${Object.entries(perType).map(([k, v]) => `${v.toLocaleString()} ${k}`).join(", ")}.`);
        if (report.bottingPct >= 40) greet.push(`Botting risk: **${report.bottingPct}%** — the mix looks a bit artificial.`);
        else greet.push(`Botting risk is **${report.bottingPct}%** — looks quite natural.`);
      }
      greet.push("You can ask — 'How many likes should I add?', 'Is this safe?', 'How long will delivery take?'");
      setMessages([{ role: "assistant", content: greet.join(" ") }]);
    }
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]); // eslint-disable-line

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content || loading) return;
    const newMsgs: ChatMsg[] = [...messages, { role: "user", content }];
    setMessages(newMsgs);
    setInput("");
    setLoading(true);
    const { data, error } = await supabase.functions.invoke("ai-speed-recommender", {
      body: { link, platform: detectedPlatform.toLowerCase(), perType, messages: newMsgs },
    });
    setLoading(false);
    if (error || data?.error) {
      toast({ title: "AI error", description: error?.message || data?.error, variant: "destructive" });
      return;
    }
    setMessages([...newMsgs, { role: "assistant", content: data?.reply || "(empty reply)" }]);
    setTimeout(() => inputRef.current?.focus(), 50);
  };

  const quickAsks = [
    "Is this safe?",
    "How long will delivery take?",
    "How many more likes should I add?",
    "Suggest the best ratio",
  ];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5 border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
        >
          <Brain className="w-3.5 h-3.5" />
          Ask AI
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg p-0 overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2 border-b">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Sparkles className="w-4 h-4 text-amber-700" />
            Organic AI Assistant
          </DialogTitle>
          <DialogDescription className="text-xs">
            Analyzes your link and gives real-time engagement guidance.
          </DialogDescription>
        </DialogHeader>

        {/* Context summary */}
        <div className="px-4 py-3 bg-muted/40 border-b space-y-2">
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <Badge variant="outline" className="font-semibold">{detectedPlatform}</Badge>
            <Badge variant="outline">{detectedPostType}</Badge>
            {linkOk ? (
              <span className="text-muted-foreground truncate max-w-[260px]">{link}</span>
            ) : (
              <span className="text-amber-600 flex items-center gap-1"><AlertTriangle className="w-3 h-3" />paste a link</span>
            )}
          </div>
          {Object.keys(perType).length > 0 && (
            <div className="grid grid-cols-3 gap-2 text-[11px]">
              {(["views", "likes", "comments"] as const).map((k) => {
                const v = perType[k] ?? 0;
                if (!v) return null;
                const Icon = k === "views" ? Eye : k === "likes" ? Heart : MessageCircle;
                return (
                  <div key={k} className="rounded-md bg-background border px-2 py-1.5 flex items-center gap-1.5">
                    <Icon className="w-3 h-3 text-muted-foreground" />
                    <span className="font-semibold">{v.toLocaleString()}</span>
                    <span className="text-muted-foreground capitalize">{k}</span>
                  </div>
                );
              })}
            </div>
          )}
          {Object.keys(perType).length > 0 && perType.views > 0 && (
            <div className="flex items-center gap-2 text-[11px]">
              <ShieldCheck className={`w-3.5 h-3.5 ${report.bottingPct >= 40 ? "text-red-500" : report.bottingPct >= 20 ? "text-amber-500" : "text-emerald-600"}`} />
              <span>Health: <strong>{report.healthScore}/100</strong></span>
              <span>•</span>
              <span>Botting risk: <strong>{report.bottingPct}%</strong></span>
            </div>
          )}
        </div>

        {/* Chat thread */}
        <div ref={scrollRef} className="px-4 py-3 max-h-[300px] overflow-y-auto space-y-3">
          {messages.map((m, i) => (
            <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                m.role === "user"
                  ? "bg-amber-700 text-white rounded-br-sm"
                  : "bg-muted text-foreground rounded-bl-sm"
              }`}>
                <div className="prose prose-sm max-w-none prose-p:my-1 prose-strong:text-current">
                  <ReactMarkdown>{m.content}</ReactMarkdown>
                </div>
              </div>
            </div>
          ))}
          {loading && (
            <div className="flex justify-start">
              <div className="bg-muted rounded-2xl px-3 py-2 flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="w-3 h-3 animate-spin" /> thinking…
              </div>
            </div>
          )}
        </div>

        {/* Quick chips */}
        {messages.length <= 1 && (
          <div className="px-4 pb-2 flex flex-wrap gap-1.5">
            {quickAsks.map((q) => (
              <button
                key={q}
                onClick={() => send(q)}
                disabled={loading}
                className="text-[11px] px-2 py-1 rounded-full border border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50"
              >
                {q}
              </button>
            ))}
          </div>
        )}

        {/* Composer */}
        <form
          className="flex gap-2 p-3 border-t bg-background"
          onSubmit={(e) => { e.preventDefault(); send(); }}
        >
          <Input
            ref={inputRef}
            placeholder="Type your question…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
            className="h-9"
          />
          <Button type="submit" size="sm" disabled={loading || !input.trim()} className="bg-amber-700 hover:bg-amber-800">
            <Send className="w-4 h-4" />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
