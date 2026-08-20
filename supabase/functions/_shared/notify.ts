// Shared helper: send a Telegram message to an app user via their linked chat.
// Uses the Lovable Telegram connector gateway. Fire-and-forget; never throws.

const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

export async function notifyUserTelegram(
  supabase: any,
  userId: string,
  message: string,
): Promise<void> {
  try {
    if (!userId || !message) return;
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    const TELEGRAM_API_KEY = Deno.env.get("TELEGRAM_API_KEY");
    if (!LOVABLE_API_KEY || !TELEGRAM_API_KEY) return;

    const { data: link } = await supabase
      .from("telegram_engagement_links")
      .select("telegram_chat_id,status")
      .eq("user_id", userId)
      .maybeSingle();
    const chatId = link?.telegram_chat_id;
    if (!chatId || link?.status !== "linked") return;

    await fetch(`${GATEWAY_URL}/sendMessage`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "X-Connection-Api-Key": TELEGRAM_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: message.slice(0, 3900),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("notifyUserTelegram failed:", e);
  }
}

export function statusEmoji(s: string): string {
  switch (s) {
    case "pending": return "⏳";
    case "processing": return "⚙️";
    case "completed": return "✅";
    case "partial": return "🟡";
    case "failed": return "❌";
    case "cancelled": return "🚫";
    case "paused": return "⏸️";
    default: return "ℹ️";
  }
}
