#!/usr/bin/env bash
set -Eeuo pipefail

container_id="${1:?bot container id is required}"
runtime_env_ok=true
telegram_ok=true

if ! docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$container_id" |
  awk -F= '
    BEGIN {
      split("DATABASE_URL TELEGRAM_BOT_TOKEN TELEGRAM_CHANNEL_ID OPENAI_API_KEY GEMINI_API_KEY EXA_API_KEY NOTION_API_KEY NOTION_AGENT_RUNS_DATA_SOURCE_ID NOTION_PIPELINE_AGENT_PAGE_ID", required, " ")
      for (i in required) state[required[i]] = "missing"
    }
    {
      key = $1
      if (!(key in state)) next
      value = substr($0, length(key) + 2)
      normalized = tolower(value)
      if (value == "") state[key] = "empty"
      else if (normalized ~ /placeholder|change-me|changeme|local-integration/) state[key] = "placeholder"
      else state[key] = "present"
    }
    END {
      failed = 0
      for (i in required) {
        print "RuntimeEnv " required[i] "=" state[required[i]]
        if (state[required[i]] != "present") failed = 1
      }
      exit failed
    }
  ' | sort; then
  runtime_env_ok=false
fi

if ! docker exec -i "$container_id" node --input-type=module <<'NODE'
const token = process.env.TELEGRAM_BOT_TOKEN;
const channelId = process.env.TELEGRAM_CHANNEL_ID;

async function telegram(method, body) {
  if (!token) return { ok: false };
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  return response.json();
}

try {
  const me = await telegram("getMe");
  const webhook = await telegram("getWebhookInfo");
  const chat = channelId ? await telegram("getChat", { chat_id: channelId }) : { ok: false };
  const webhookConfigured = Boolean(webhook.ok && webhook.result.url);

  console.log(`TelegramProbe getMe_ok=${Boolean(me.ok)}`);
  console.log(`TelegramProbe webhook_ok=${Boolean(webhook.ok)} webhook_configured=${webhookConfigured}`);
  console.log(`TelegramProbe channel_ok=${Boolean(chat.ok)} channel_type=${chat.ok ? chat.result.type : "unavailable"}`);

  if (!me.ok || !webhook.ok || webhookConfigured || !chat.ok) process.exitCode = 1;
} catch (error) {
  console.log(`TelegramProbe network_ok=false error_type=${error?.name || "Error"}`);
  process.exitCode = 1;
}
NODE
then
  telegram_ok=false
fi

if [[ "$runtime_env_ok" != "true" || "$telegram_ok" != "true" ]]; then
  echo "Production runtime credential verification failed." >&2
  exit 1
fi

echo "Production runtime credentials verified."
