import * as cheerio from "cheerio";
import { hashText } from "./feed.js";
import { fetchPublicHttp } from "./safe-fetch.js";

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
  const { response, finalUrl } = await fetchPublicHttp(articleUrl, {
    fetchImpl,
    lookupImpl,
    timeoutMs,
    maxRedirects,
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "telegram-news-agent/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`Primary page request failed with HTTP ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("html")) {
    throw new Error(`Primary page returned unsupported content type: ${contentType}`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength && declaredLength > maxBytes) {
    throw new Error(`Primary page exceeds ${maxBytes} bytes`);
  }

  const html = await response.text();
  if (Buffer.byteLength(html) > maxBytes) {
    throw new Error(`Primary page exceeds ${maxBytes} bytes`);
  }

  const text = extractArticleText(html);
  return {
    text,
    contentHash: hashText(text),
    finalUrl: finalUrl.toString(),
  };
}
