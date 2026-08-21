import { recordAiUsageEvents } from "./ai-usage.js";
import { classifyProviderError } from "./ai-provider.js";

const DEFAULT_TIME_ZONE = "Europe/Madrid";
const EXA_TEST_COOLDOWN_MS = 5 * 60 * 1000;
const EXA_TEST_COOLDOWNS = new Map();
const PROVIDERS = [
  ["openai", "OpenAI"],
  ["gemini", "Gemini"],
  ["exa", "Exa"],
];

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function localDateTime(value, timeZone) {
  if (!value) return "never";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

function safeVersion(value) {
  return (
    String(value ?? "local")
      .replace(/[^A-Za-z0-9._+-]/g, "")
      .slice(0, 80) || "local"
  );
}

function providerLine({ name, label, active, usage, testResult, timeZone }) {
  if (!active) return `⚪ ${label} · disabled`;
  if (name === "exa" && testResult?.ok === false) {
    return `🔴 ${label} · live test failed (${testResult.errorCode})`;
  }
  if (name === "exa" && testResult?.ok === true) {
    const ledger = testResult.usageRecorded
      ? "usage recorded"
      : "usage record not confirmed";
    return `🟢 ${label} · live search passed · ${ledger}`;
  }
  const calls = numeric(usage?.request_count);
  if (calls > 0) {
    return `🟢 ${label} · ${calls} call${calls === 1 ? "" : "s"} today · last ${localDateTime(usage.last_success_at, timeZone)}`;
  }
  if (usage?.last_success_at) {
    return `🟡 ${label} · ready, no calls today · last success ${localDateTime(usage.last_success_at, timeZone)}`;
  }
  return `🟡 ${label} · configured, no successful call recorded`;
}

export function parseStatusCommand(text) {
  if (typeof text !== "string") return null;
  const match = /^\/status(?:@([A-Za-z0-9_]+))?(\s.*)?$/i.exec(text.trim());
  if (!match) return null;
  return {
    botUsername: match[1] ?? null,
    malformed: Boolean(match[2]?.trim()),
  };
}

export function parseStatusCallback(data) {
  return data === "status:test:exa" ? { action: "test_exa" } : null;
}

export function renderSystemStatus(
  { dashboard, providerNames = [], appVersion = "local", testResult = null },
  { timeZone = DEFAULT_TIME_ZONE } = {},
) {
  const active = new Set(providerNames);
  const usageByProvider = new Map(
    (dashboard?.providers ?? []).map((row) => [row.provider, row]),
  );
  return [
    "🩺 System status",
    `Version: ${safeVersion(appVersion)}`,
    "",
    "🟢 PostgreSQL · connected",
    "🟢 Telegram · private control and polling available",
    "",
    "AI providers",
    ...PROVIDERS.map(([name, label]) =>
      providerLine({
        name,
        label,
        active: active.has(name),
        usage: usageByProvider.get(name),
        testResult,
        timeZone,
      }),
    ),
    "",
    "Yellow means configured but idle, not broken. Testing Exa consumes exactly one search request.",
  ].join("\n");
}

function statusMarkup(providerNames) {
  return new Set(providerNames).has("exa")
    ? {
        inline_keyboard: [
          [
            {
              text: "🔎 Test Exa now · 1 search",
              callback_data: "status:test:exa",
            },
          ],
        ],
      }
    : { inline_keyboard: [] };
}

async function dashboard(repository, channelId, now, timeZone) {
  return repository.getDailyUsageDashboard({
    channelId,
    now: now().toISOString(),
    timeZone,
  });
}

export async function showSystemStatus({
  token,
  channelId,
  chatId,
  repository,
  callTelegram,
  providerNames,
  appVersion,
  now = () => new Date(),
  timeZone = DEFAULT_TIME_ZONE,
}) {
  const current = await dashboard(repository, channelId, now, timeZone);
  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: renderSystemStatus(
      { dashboard: current, providerNames, appVersion },
      { timeZone },
    ),
    reply_markup: statusMarkup(providerNames),
  });
  return current;
}

export async function handleStatusCallback(
  callback,
  parsed,
  {
    token,
    channelId,
    repository,
    callTelegram,
    aiProvider,
    providerNames,
    appVersion,
    now = () => new Date(),
    timeZone = DEFAULT_TIME_ZONE,
    cooldownStore = EXA_TEST_COOLDOWNS,
  },
) {
  if (parsed?.action !== "test_exa") {
    throw new Error("Invalid status callback");
  }
  const chatId = callback?.message?.chat?.id;
  const messageId = callback?.message?.message_id;
  const userId = callback?.from?.id;
  if (chatId == null || messageId == null || userId == null) {
    throw new Error("Status callback is missing its private binding");
  }
  const cooldownKey = `${chatId}:${userId}`;
  const currentTime = now();
  const previous = cooldownStore.get(cooldownKey);
  if (previous && currentTime.valueOf() - previous < EXA_TEST_COOLDOWN_MS) {
    await callTelegram(token, "answerCallbackQuery", {
      callback_query_id: callback.id,
      text: "Exa was tested recently. Try again in five minutes.",
      show_alert: true,
    });
    return { auditResult: "Skipped an Exa live test during its cooldown." };
  }
  cooldownStore.set(cooldownKey, currentTime.valueOf());
  await callTelegram(token, "answerCallbackQuery", {
    callback_query_id: callback.id,
    text: "Testing Exa with one search request...",
  });

  let testResult;
  try {
    const result = await aiProvider.testExaConnection();
    const recorded = await recordAiUsageEvents(repository, result.usageEvents, {
      channelId,
    });
    testResult = {
      ok: true,
      usageRecorded: recorded.length === (result.usageEvents?.length ?? 0),
    };
  } catch (error) {
    testResult = { ok: false, errorCode: classifyProviderError(error) };
  }

  const current = await dashboard(repository, channelId, now, timeZone);
  await callTelegram(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text: renderSystemStatus(
      { dashboard: current, providerNames, appVersion, testResult },
      { timeZone },
    ),
    reply_markup: statusMarkup(providerNames),
  });
  return {
    auditResult: testResult.ok
      ? "Completed one explicit Exa live search and refreshed provider status."
      : `Exa live search failed with sanitized code ${testResult.errorCode}.`,
  };
}
