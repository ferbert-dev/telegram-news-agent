import { pathToFileURL } from "node:url";
import pg from "pg";
import { callTelegram } from "./telegram.js";

const { Client } = pg;

export function renderDeploymentNotification(version) {
  const safeVersion =
    String(version ?? "unknown")
      .replace(/[^A-Za-z0-9._+-]/g, "")
      .slice(0, 80) || "unknown";
  return [
    "🤖 Bot deployment complete",
    `Version: ${safeVersion}`,
    "Status: 🟢 healthy",
    "PostgreSQL, runtime credentials, Telegram identity, and channel access passed.",
  ].join("\n");
}

export async function sendDeploymentNotifications({
  chatIds,
  version,
  token,
  telegram,
}) {
  const uniqueChatIds = [...new Set(chatIds.map(String))];
  const outcome = { eligible: 0, sent: 0, skipped: 0, failed: 0 };
  for (const chatId of uniqueChatIds) {
    try {
      const chat = await telegram(token, "getChat", { chat_id: chatId });
      if (chat?.type !== "private") {
        outcome.skipped += 1;
        continue;
      }
      outcome.eligible += 1;
      await telegram(token, "sendMessage", {
        chat_id: chatId,
        text: renderDeploymentNotification(version),
      });
      outcome.sent += 1;
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const version = process.env.APP_VERSION?.trim();
  if (!databaseUrl || !token || !version) {
    throw new Error("Deployment notification runtime is not configured");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query(
      `select distinct review_chat_id::text as chat_id
       from public.news_bot_settings
       where review_chat_id is not null
       order by review_chat_id::text`,
    );
    const outcome = await sendDeploymentNotifications({
      chatIds: result.rows.map((row) => row.chat_id),
      version,
      token,
      telegram: (telegramToken, method, body) =>
        callTelegram(telegramToken, method, body, {
          signal: AbortSignal.timeout(10_000),
        }),
    });
    console.log(
      JSON.stringify({ event: "deployment_notification", version, ...outcome }),
    );
    if (outcome.sent === 0 && outcome.failed > 0) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(
      JSON.stringify({
        event: "deployment_notification_failed",
        error_code: "notification_failed",
      }),
    );
    process.exitCode = 1;
  });
}
