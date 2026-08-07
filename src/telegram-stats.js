const DEFAULT_TIME_ZONE = "Europe/Madrid";

function numeric(value) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function tokens(value) {
  return new Intl.NumberFormat("en-US").format(numeric(value));
}

function usd(value) {
  const number = numeric(value);
  return `$${number.toFixed(number < 0.01 ? 6 : 4)}`;
}

function localTime(value, timeZone) {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}

export function renderUsageDashboard(
  dashboard,
  { timeZone = DEFAULT_TIME_ZONE } = {},
) {
  const summary = dashboard?.summary ?? {};
  const posts = dashboard?.posts ?? [];
  const requestCount = numeric(summary.request_count);
  const pricedCount = numeric(summary.priced_request_count);
  const cost = numeric(summary.estimated_cost_usd);
  const lines = [
    "📊 AI usage today",
    `Timezone: ${timeZone}`,
    "",
    `API requests: ${tokens(requestCount)}`,
    `Input tokens: ${tokens(summary.input_tokens)}`,
    `↳ cached input: ${tokens(summary.cached_input_tokens)}`,
    `Output tokens: ${tokens(summary.output_tokens)}`,
    `↳ reasoning: ${tokens(summary.reasoning_tokens)}`,
    `Web searches: ${tokens(summary.web_search_calls)}`,
    `Estimated list cost: ${usd(cost)}`,
  ];

  if (pricedCount < requestCount) {
    lines.push(`Priced requests: ${tokens(pricedCount)}/${tokens(requestCount)}`);
  }

  const publishedPostCount = numeric(
    summary.published_post_count ?? posts.length,
  );
  lines.push("", `Published posts today: ${tokens(publishedPostCount)}`);
  if (posts.length) {
    if (publishedPostCount > posts.length) {
      lines.push(`Latest ${posts.length} post costs:`);
    }
    for (const post of posts) {
      const tracked = numeric(post.usage_request_count) > 0;
      lines.push(
        `• #${post.telegram_message_id} · ${localTime(post.published_at, timeZone)} · ${post.editor_name} · ${tracked ? usd(post.estimated_cost_usd) : "not tracked"}`,
      );
    }
  } else if (requestCount === 0) {
    lines.push("No API usage has been recorded today.");
  }

  lines.push(
    "",
    "Estimate uses saved standard list prices. Your actual OpenAI bill may be lower because sharing allowances and credits are not reported per response.",
  );
  return lines.join("\n");
}

export async function showUsageDashboard({
  token,
  channelId,
  chatId,
  repository,
  callTelegram,
  now = () => new Date(),
  timeZone = DEFAULT_TIME_ZONE,
}) {
  const dashboard = await repository.getDailyUsageDashboard({
    channelId,
    now: now().toISOString(),
    timeZone,
  });
  await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text: renderUsageDashboard(dashboard, { timeZone }),
  });
  return dashboard;
}
