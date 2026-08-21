import { createHash } from "node:crypto";
import Exa from "exa-js";
import { FactSearchEvidence } from "./ai-fact-search.js";
import { FeedDiscovery } from "./ai-feed-discovery.js";
import { NewsDiscovery } from "./ai-news-discovery.js";
import { exaUsageEvent } from "./ai-usage.js";

const EXA_SEARCH_TYPES = new Set([
  "auto",
  "fast",
  "hybrid",
  "instant",
  "keyword",
  "neural",
]);
const HOUR_MS = 60 * 60 * 1000;
const PROCESS_DAILY_SEARCH_USAGE = new Map();
const OFFICIAL_HOSTS = [
  "europa.eu",
  "un.org",
  "who.int",
  "nato.int",
  "oecd.org",
  "worldbank.org",
  "esa.int",
];
const GOVERNMENT_HOSTS = [
  "gov.uk",
  "gov.au",
  "gov.ca",
  "gov.nz",
  "gov.sg",
  "gob.es",
  "gouv.fr",
  "bund.de",
];
const ACADEMIC_HOSTS = [
  "ac.uk",
  "edu.au",
  "edu.ca",
  "arxiv.org",
  "doi.org",
  "nature.com",
  "science.org",
  "cell.com",
  "pnas.org",
  "nejm.org",
];
const REPUTABLE_NEWS_HOSTS = [
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "dw.com",
  "theguardian.com",
  "ft.com",
  "bloomberg.com",
  "npr.org",
  "politico.com",
  "euronews.com",
  "aljazeera.com",
  "tagesschau.de",
  "spiegel.de",
  "zeit.de",
  "elpais.com",
  "lemonde.fr",
];

export class ExaDailySearchCapError extends Error {
  constructor(cap) {
    super(`Exa daily search cap of ${cap} calls was reached`);
    this.name = "ExaDailySearchCapError";
    this.code = "exa_daily_search_cap";
    this.status = 429;
  }
}

function booleanSetting(value, name, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultValue;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
}

function boundedInteger(value, { name, defaultValue, minimum, maximum }) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return parsed;
}

function limitedText(value, maximum) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maximum) : null;
}

function publicHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return null;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function searchTerms(input = {}) {
  const values = [
    input.query,
    ...(input.topicCodes ?? []),
    ...(input.customTopics ?? []),
  ];
  return [...new Set(values.map((value) => limitedText(value, 180)).filter(Boolean))]
    .join(" ")
    .slice(0, 900);
}

function resultSummary(result) {
  const highlights = Array.isArray(result?.highlights)
    ? result.highlights.map((value) => limitedText(value, 500)).filter(Boolean)
    : [];
  return limitedText(highlights.join(" ") || result?.text, 1_500);
}

function normalizeNewsResults(response, limit) {
  const items = [];
  for (const result of response?.results ?? []) {
    const title = limitedText(result?.title, 300);
    const url = publicHttpUrl(result?.url);
    const summary = resultSummary(result);
    if (!title || !url || !summary) continue;
    items.push({
      title,
      url,
      summary,
      publishedAt: normalizedDate(result?.publishedDate ?? result?.publishedAt),
      author: limitedText(result?.author, 200),
    });
    if (items.length >= limit) break;
  }
  return NewsDiscovery.parse({ items });
}

function matchesHost(hostname, allowedHosts) {
  return allowedHosts.some(
    (allowed) => hostname === allowed || hostname.endsWith(`.${allowed}`),
  );
}

function sourceKind(url) {
  const hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  if (
    hostname.endsWith(".gov") ||
    matchesHost(hostname, GOVERNMENT_HOSTS)
  ) {
    return "government";
  }
  if (
    hostname.endsWith(".edu") ||
    matchesHost(hostname, ACADEMIC_HOSTS)
  ) {
    return "academic";
  }
  if (matchesHost(hostname, OFFICIAL_HOSTS)) return "official";
  if (matchesHost(hostname, REPUTABLE_NEWS_HOSTS)) return "reputable_news";
  return null;
}

function normalizeFactResult(response) {
  for (const result of response?.results ?? []) {
    const sourceUrl = publicHttpUrl(result?.url);
    const sourceTitle = limitedText(result?.title, 300);
    const evidenceText = Array.isArray(result?.highlights)
      ? result.highlights
          .map((highlight) => limitedText(highlight, 500))
          .find(Boolean) ?? null
      : null;
    const kind = sourceUrl ? sourceKind(sourceUrl) : null;
    if (!sourceUrl || !sourceTitle || !evidenceText || !kind) continue;
    return FactSearchEvidence.parse({
      fact: {
        claim: evidenceText,
        sourceUrl,
        sourceTitle,
        sourceKind: kind,
        evidenceText,
      },
    });
  }
  return { fact: null };
}

function looksLikeFeedUrl(value) {
  const url = new URL(value);
  return (
    /(?:^|[/.?&=_-])(rss|atom|feed)(?:$|[/.?&=_-])/i.test(
      `${url.pathname}${url.search}`,
    ) || /\.(?:rss|atom|xml)$/i.test(url.pathname)
  );
}

function normalizeFeedResults(response, limit) {
  const items = [];
  for (const result of response?.results ?? []) {
    const feedUrl = publicHttpUrl(result?.url);
    if (!feedUrl || !looksLikeFeedUrl(feedUrl)) continue;
    const parsed = new URL(feedUrl);
    items.push({
      name:
        limitedText(result?.title, 160) ??
        parsed.hostname.replace(/^www\./, "").slice(0, 160),
      feedUrl,
      homepageUrl: parsed.origin,
    });
    if (items.length >= limit) break;
  }
  return FeedDiscovery.parse({ items });
}

export function getExaProviderConfig(env = process.env) {
  const enabled = booleanSetting(env.EXA_ENABLED, "EXA_ENABLED", false);
  const apiKey = env.EXA_API_KEY?.trim();
  if (!enabled || !apiKey) return null;

  const searchType = env.EXA_SEARCH_TYPE?.trim().toLowerCase() || "auto";
  if (!EXA_SEARCH_TYPES.has(searchType)) {
    throw new Error(
      "EXA_SEARCH_TYPE must be one of auto, fast, hybrid, instant, keyword, neural",
    );
  }

  return {
    apiKey,
    searchType,
    model: env.EXA_MODEL?.trim() || `exa-search:${searchType}`,
    dailySearchCap: boundedInteger(env.EXA_DAILY_SEARCH_CAP, {
      name: "EXA_DAILY_SEARCH_CAP",
      defaultValue: 20,
      minimum: 1,
      maximum: 1_000,
    }),
    maxResults: boundedInteger(env.EXA_MAX_RESULTS, {
      name: "EXA_MAX_RESULTS",
      defaultValue: 8,
      minimum: 1,
      maximum: 10,
    }),
  };
}

export function createExaProvider(
  config = getExaProviderConfig(),
  {
    client,
    now = () => new Date(),
    capStore = PROCESS_DAILY_SEARCH_USAGE,
  } = {},
) {
  if (!config) return null;
  const exa = client ?? new Exa(config.apiKey);
  const quotaKey = createHash("sha256").update(config.apiKey).digest("hex");

  const reserveSearch = () => {
    const date = now().toISOString().slice(0, 10);
    const current = capStore.get(quotaKey);
    const calls = current?.date === date ? current.calls : 0;
    if (calls >= config.dailySearchCap) {
      throw new ExaDailySearchCapError(config.dailySearchCap);
    }
    capStore.set(quotaKey, { date, calls: calls + 1 });
  };

  const executeSearch = async (query, options, operation) => {
    reserveSearch();
    const response = await exa.search(query, options);
    return {
      response,
      usageEvents: [
        exaUsageEvent(response, { model: config.model, operation }),
      ],
    };
  };

  return {
    name: "exa",
    model: config.model,

    async testConnection() {
      const { response, usageEvents } = await executeSearch(
        "OpenAI official AI product news",
        {
          type: config.searchType,
          numResults: 1,
          includeDomains: ["openai.com"],
          contents: false,
        },
        "health_check",
      );
      return {
        ok: true,
        resultCount: Array.isArray(response?.results)
          ? response.results.length
          : 0,
        provider: "exa",
        model: config.model,
        usageEvents,
      };
    },

    async searchNews(input = {}) {
      const limit = Math.max(
        1,
        Math.min(config.maxResults, Number(input.limit) || config.maxResults),
      );
      const query = searchTerms(input);
      if (!query) throw new Error("Exa news search query is empty");
      const windowHours = Math.max(
        1,
        Math.min(24 * 30, Number(input.windowHours) || 48),
      );
      const { response, usageEvents } = await executeSearch(
        query,
        {
          type: config.searchType,
          category: "news",
          numResults: limit,
          startPublishedDate: new Date(
            now().valueOf() - windowHours * HOUR_MS,
          ).toISOString(),
          contents: {
            text: { maxCharacters: 2_000 },
            highlights: { query },
          },
        },
        "news_search",
      );
      return {
        ...normalizeNewsResults(response, limit),
        provider: "exa",
        model: config.model,
        usageEvents,
      };
    },

    async searchFact(input = {}) {
      const query = searchTerms({
        query: input.query,
        customTopics: [input.expectedClaim],
      });
      if (!query) throw new Error("Exa fact search query is empty");
      const limit = Math.min(5, config.maxResults);
      const { response, usageEvents } = await executeSearch(
        query,
        {
          type: config.searchType,
          numResults: limit,
          contents: {
            text: { maxCharacters: 3_500 },
            highlights: { query },
          },
        },
        "editorial_fact_search",
      );
      return {
        ...normalizeFactResult(response),
        provider: "exa",
        model: config.model,
        usageEvents,
      };
    },

    async searchFeeds(input = {}) {
      const limit = Math.max(
        1,
        Math.min(
          8,
          config.maxResults,
          Number(input.limit) || config.maxResults,
        ),
      );
      const subjects = searchTerms(input) || "technology science world news";
      const query = `official RSS or Atom feed ${subjects}`.slice(0, 900);
      const { response, usageEvents } = await executeSearch(
        query,
        {
          type: config.searchType,
          numResults: limit,
          contents: { text: { maxCharacters: 500 } },
        },
        "feed_source_search",
      );
      return {
        ...normalizeFeedResults(response, limit),
        provider: "exa",
        model: config.model,
        usageEvents,
      };
    },
  };
}
