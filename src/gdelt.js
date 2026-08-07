import { assertPublicHttpUrl, fetchPublicHttp } from "./safe-fetch.js";
import { canonicalizeUrl, hashText } from "./feed.js";

const DEFAULT_GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const TOPIC_TERMS = Object.freeze({
  ai: ["artificial intelligence"],
  world: ["international crisis", "election", "diplomacy", "disaster"],
  science: ["scientific discovery", "research breakthrough"],
  nature: ["climate change", "biodiversity", "ecosystem"],
  animals: ["wildlife", "endangered species"],
  history: ["archaeological discovery", "ancient history"],
  culture: ["cultural heritage", "literature", "arts"],
  technology: ["technology", "innovation", "engineering"],
  society: ["public health", "education", "human development"],
});

function cleanTerm(value) {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 60);
  if (normalized.length < 2) return null;
  return normalized.includes(" ") ? `"${normalized}"` : normalized;
}

export function buildGdeltQuery({ topicCodes = [], customTopics = [] } = {}) {
  const requested = [
    ...customTopics,
    ...topicCodes.flatMap((code) => TOPIC_TERMS[code] ?? []),
  ];
  const terms = [...new Set(requested.map(cleanTerm).filter(Boolean))].slice(
    0,
    16,
  );
  return terms.length ? `(${terms.join(" OR ")})` : "breaking news";
}

function gdeltTimespan(windowHours) {
  const hours = Math.max(1, Math.min(24 * 365, Number(windowHours) || 48));
  return hours <= 72 ? `${Math.ceil(hours)}h` : `${Math.ceil(hours / 24)}d`;
}

function parseSeenDate(value) {
  const text = String(value ?? "").trim();
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(
    text,
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}Z`,
  );
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

export async function fetchGdeltDiscoveries(
  apiUrl = DEFAULT_GDELT_URL,
  {
    topicCodes = [],
    customTopics = [],
    windowHours = 48,
    maxRecords = 75,
    fetchImpl = fetch,
    lookupImpl,
    timeoutMs = 25_000,
    maxBytes = MAX_RESPONSE_BYTES,
  } = {},
) {
  const endpoint = assertPublicHttpUrl(apiUrl);
  endpoint.search = "";
  endpoint.searchParams.set(
    "query",
    buildGdeltQuery({ topicCodes, customTopics }),
  );
  endpoint.searchParams.set("mode", "ArtList");
  endpoint.searchParams.set("format", "json");
  endpoint.searchParams.set("sort", "HybridRel");
  endpoint.searchParams.set(
    "maxrecords",
    String(Math.max(1, Math.min(250, Number(maxRecords) || 75))),
  );
  endpoint.searchParams.set("timespan", gdeltTimespan(windowHours));

  const { response, finalUrl } = await fetchPublicHttp(endpoint, {
    fetchImpl,
    lookupImpl,
    timeoutMs,
    maxRedirects: 3,
    headers: {
      accept: "application/json",
      "user-agent": "telegram-news-agent/0.1 (personal news reader)",
    },
  });
  if (!response.ok) {
    throw new Error(`GDELT request failed with HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength && declaredLength > maxBytes) {
    throw new Error(`GDELT response exceeds ${maxBytes} bytes`);
  }
  const body = await response.text();
  if (Buffer.byteLength(body) > maxBytes) {
    throw new Error(`GDELT response exceeds ${maxBytes} bytes`);
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error("GDELT returned invalid JSON");
  }

  const articles = Array.isArray(parsed?.articles) ? parsed.articles : [];
  const discoveries = [];
  for (const article of articles) {
    try {
      const title = String(article?.title ?? "").trim();
      if (!title) continue;
      const canonicalUrl = canonicalizeUrl(
        assertPublicHttpUrl(article?.url).toString(),
      );
      const publisher =
        String(article?.domain ?? "").trim() ||
        new URL(canonicalUrl).hostname.replace(/^www\./, "");
      discoveries.push({
        title,
        canonicalUrl,
        author: null,
        publishedAt: parseSeenDate(article?.seendate),
        summary: title,
        publisher,
        language: String(article?.language ?? "").trim() || null,
        sourceCountry: String(article?.sourcecountry ?? "").trim() || null,
        contentHash: hashText([canonicalUrl, title].join("\n")),
        discoveryKind: "gdelt",
        discoveryUrl: finalUrl.toString(),
        verificationStatus: "web_source",
      });
    } catch {
      // GDELT is an untrusted index; malformed or private URLs are discarded.
    }
  }
  return discoveries;
}
