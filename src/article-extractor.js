import * as cheerio from "cheerio";
import { hashText } from "./feed.js";
import { assertPublicHttpUrl, fetchPublicHttp } from "./safe-fetch.js";

const MAX_ARTICLE_BYTES = 5 * 1024 * 1024;
const MAX_EXTRACTED_CHARACTERS = 50_000;
const MIN_EXTRACTED_CHARACTERS = 200;
const CONTENT_SELECTORS = [
  "article",
  "main",
  '[role="main"]',
  ".article-body",
  ".article-content",
  ".post-content",
];
const BLOCK_SELECTOR = "h1, h2, h3, p, li, blockquote";
const REMOVE_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "nav",
  "footer",
  "header",
  "aside",
  "form",
  "svg",
  "canvas",
  "iframe",
].join(", ");
const GOOGLE_NEWS_HOSTS = new Set(["news.google.com"]);
const EXTRACTOR_MAX_ATTEMPTS = 2;

function normalizedHost(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isGoogleNewsUrl(value) {
  const host = normalizedHost(value);
  return GOOGLE_NEWS_HOSTS.has(host) || host.endsWith(".news.google.com");
}

function parsePublicUrl(value, baseUrl) {
  if (!value) return null;
  try {
    return assertPublicHttpUrl(new URL(value, baseUrl).toString()).toString();
  } catch {
    return null;
  }
}

function canonicalUrlCandidates(html, baseUrl) {
  const $ = cheerio.load(html);
  const values = [
    $('link[rel="canonical"]').attr("href"),
    $('meta[property="og:url"]').attr("content"),
    $('meta[name="twitter:url"]').attr("content"),
    $('meta[name="parsely-link"]').attr("content"),
  ];

  $('script[type="application/ld+json"]').each((_index, element) => {
    try {
      const parsed = JSON.parse($(element).text());
      const records = Array.isArray(parsed) ? parsed : [parsed];
      for (const record of records) {
        if (typeof record?.url === "string") values.push(record.url);
        if (typeof record?.mainEntityOfPage === "string") {
          values.push(record.mainEntityOfPage);
        }
        if (typeof record?.mainEntityOfPage?.["@id"] === "string") {
          values.push(record.mainEntityOfPage["@id"]);
        }
      }
    } catch {
      // Ignore malformed publisher metadata and continue with other candidates.
    }
  });

  return values
    .map((value) => parsePublicUrl(value, baseUrl))
    .filter(Boolean)
    .filter((value) => !isGoogleNewsUrl(value));
}

function resolvePublisherUrl(html, sourceUrl) {
  const sourceHost = normalizedHost(sourceUrl);
  return (
    canonicalUrlCandidates(html, sourceUrl).find(
      (candidate) => normalizedHost(candidate) !== sourceHost,
    ) ?? null
  );
}

async function fetchPageBody(articleUrl, options) {
  const { fetchImpl, lookupImpl, timeoutMs, maxBytes, maxRedirects, headers } =
    options;
  const { response, finalUrl } = await fetchPublicHttp(articleUrl, {
    fetchImpl,
    lookupImpl,
    timeoutMs,
    maxRedirects,
    headers,
  });

  if (!response.ok) {
    throw new Error(`Primary page request failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("html")) {
    throw new Error(
      `Primary page returned unsupported content type: ${contentType}`,
    );
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength && declaredLength > maxBytes) {
    throw new Error(`Primary page exceeds ${maxBytes} bytes`);
  }

  const html = await response.text();
  if (Buffer.byteLength(html) > maxBytes) {
    throw new Error(`Primary page exceeds ${maxBytes} bytes`);
  }

  return { html, finalUrl: finalUrl.toString() };
}

function normalizeText(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function extractArticleText(html) {
  const $ = cheerio.load(html);
  $(REMOVE_SELECTOR).remove();

  let root = $("body");
  for (const selector of CONTENT_SELECTORS) {
    const candidates = $(selector);
    if (candidates.length) {
      root = candidates
        .toArray()
        .map((element) => ({
          element,
          length: normalizeText($(element).text()).length,
        }))
        .sort((left, right) => right.length - left.length)[0].element;
      root = $(root);
      break;
    }
  }

  const seen = new Set();
  const blocks = [];
  root.find(BLOCK_SELECTOR).each((_index, element) => {
    const text = normalizeText($(element).text());
    if (text.length >= 20 && !seen.has(text)) {
      seen.add(text);
      blocks.push(text);
    }
  });

  const extracted = (blocks.length ? blocks.join("\n\n") : normalizeText(root.text()))
    .slice(0, MAX_EXTRACTED_CHARACTERS)
    .trim();

  if (extracted.length < MIN_EXTRACTED_CHARACTERS) {
    throw new Error(
      `Primary page yielded only ${extracted.length} characters of article text`,
    );
  }

  return extracted;
}

export async function fetchArticle(
  articleUrl,
  {
    fetchImpl = fetch,
    lookupImpl,
    timeoutMs = 15_000,
    maxBytes = MAX_ARTICLE_BYTES,
    maxRedirects = 5,
  } = {},
) {
  const headers = {
    accept: "text/html,application/xhtml+xml",
    "user-agent": "telegram-news-agent/0.1",
  };
  let requestUrl = articleUrl;
  let lastError;

  for (let attempt = 0; attempt < EXTRACTOR_MAX_ATTEMPTS; attempt += 1) {
    const { html, finalUrl } = await fetchPageBody(requestUrl, {
      fetchImpl,
      lookupImpl,
      timeoutMs,
      maxBytes,
      maxRedirects,
      headers,
    });

    try {
      const text = extractArticleText(html);
      return {
        text,
        contentHash: hashText(text),
        finalUrl,
      };
    } catch (error) {
      lastError = error;
      const canResolvePublisher =
        attempt === 0 &&
        (isGoogleNewsUrl(articleUrl) ||
          isGoogleNewsUrl(requestUrl) ||
          isGoogleNewsUrl(finalUrl));
      if (!canResolvePublisher) throw error;

      const publisherUrl = resolvePublisherUrl(html, finalUrl);
      if (!publisherUrl) throw error;
      requestUrl = publisherUrl;
    }
  }

  throw lastError;
}
