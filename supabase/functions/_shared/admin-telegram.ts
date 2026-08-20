const GATEWAY_URL = "https://connector-gateway.lovable.dev/telegram";

export function escapeTelegramHtml(value: unknown): string {
  return String(value ?? "—")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export async function notifyAdminTelegram(message: string): Promise<boolean> {
  const chatId = Deno.env.get("TELEGRAM_CHAT_ID")?.trim();
  if (!chatId || !message) {
    console.warn("Admin Telegram notification skipped: TELEGRAM_CHAT_ID not configured");
    return false;
  }

  const payload = {
    chat_id: chatId,
    text: message.slice(0, 4000),
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };

  try {
    const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim();
    let response: Response;

    if (botToken) {
      response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      const lovableApiKey = Deno.env.get("LOVABLE_API_KEY")?.trim();
      const telegramApiKey = Deno.env.get("TELEGRAM_API_KEY")?.trim();
      if (!lovableApiKey || !telegramApiKey) {
        console.warn("Admin Telegram notification skipped: bot credentials not configured");
        return false;
      }
      response = await fetch(`${GATEWAY_URL}/sendMessage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${lovableApiKey}`,
          "X-Connection-Api-Key": telegramApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    }

    const responseBody = await response.text();
    if (!response.ok) {
      console.error(`Admin Telegram notification failed [${response.status}]: ${responseBody}`);
      return false;
    }

    try {
      const result = JSON.parse(responseBody);
      if (result?.ok === false) {
        console.error("Admin Telegram provider rejected notification:", result?.error || result?.description || responseBody);
        return false;
      }
    } catch {
      // A successful non-JSON response is accepted.
    }
    return true;
  } catch (error) {
    console.error("Admin Telegram notification error:", error);
    return false;
  }
}