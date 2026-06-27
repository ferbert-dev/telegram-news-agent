const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;

export function getTelegramConfig() {
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const channelId = process.env.TELEGRAM_CHANNEL_ID?.trim();

  if (!token) {
    throw new Error("TELEGRAM_BOT_TOKEN is required");
  }

  if (!channelId) {
    throw new Error("TELEGRAM_CHANNEL_ID is required");
  }

  return { token, channelId };
}

export async function callTelegram(token, method, body) {
  let response;

  try {
    response = await fetch(`${TELEGRAM_API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new Error(`Telegram ${method} request failed`, { cause: error });
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload?.ok) {
    const description = payload?.description ?? `HTTP ${response.status}`;
    throw new Error(`Telegram ${method} failed: ${description}`);
  }

  return payload.result;
}

export function validateMessage(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Message text is required");
  }

  if (text.length > TELEGRAM_MESSAGE_MAX_LENGTH) {
    throw new Error(
      `Message exceeds Telegram's ${TELEGRAM_MESSAGE_MAX_LENGTH}-character limit`,
    );
  }

  return text.trim();
}

export async function sendTelegramMessage({
  token,
  channelId,
  text,
  disableNotification = false,
}) {
  return callTelegram(token, "sendMessage", {
    chat_id: channelId,
    text: validateMessage(text),
    disable_notification: disableNotification,
  });
}
