import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { XMLParser } from "fast-xml-parser";

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "ref",
  "source",
]);

function asArray(value) {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function textValue(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim();
  }

  if (value && typeof value === "object") {
    return textValue(value["#text"] ?? value.__cdata ?? "");
  }

  return "";
}

function atomLink(entry) {
  const links = asArray(entry.link);
  const alternate =
    links.find((link) => link?.["@_rel"] === "alternate") ?? links[0];

  return typeof alternate === "string"
    ? alternate
    : alternate?.["@_href"] ?? "";
}

function isPrivateIpLiteral(hostname) {
  if (isIP(hostname) === 4) {
    const [a, b] = hostname.split(".").map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (isIP(hostname) === 6) {
    const normalized = hostname.toLowerCase();
    return (
      normalized === "::1" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  return false;
}

export function assertPublicHttpUrl(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`Unsupported URL protocol: ${url.protocol}`);
  }

  if (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    isPrivateIpLiteral(url.hostname)
  ) {
    throw new Error(`Private or loopback URL is not allowed: ${url.hostname}`);
  }

  return url;
}

export function canonicalizeUrl(value, baseUrl) {
  const url = new URL(value, baseUrl);
  url.hash = "";

  for (const key of [...url.searchParams.keys()]) {
    if (
      key.toLowerCase().startsWith("utm_") ||
      TRACKING_PARAMS.has(key.toLowerCase())
    ) {
      url.searchParams.delete(key);
    }
  }

  url.searchParams.sort();
  return url.toString();
}

export function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function parseFeed(xml, feedUrl) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    textNodeName: "#text",
    cdataPropName: "__cdata",
    trimValues: true,
    parseTagValue: false,
    processEntities: {
      enabled: true,
      maxEntityCount: 50,
      maxExpandedLength: 50_000,
    },
  });
  const parsed = parser.parse(xml);
  const rssChannel = parsed.rss?.channel;
  const atomFeed = parsed.feed;

  if (!rssChannel && !atomFeed) {
    throw new Error("Unsupported feed: expected RSS 2.0 or Atom");
  }

  const entries = rssChannel
    ? asArray(rssChannel.item).map((item) => ({
        title: textValue(item.title),
        url: textValue(item.link) || textValue(item.guid),
        author: textValue(item.author ?? item["dc:creator"]),
        publishedAt: textValue(item.pubDate ?? item["dc:date"]),
        summary: textValue(item.description ?? item["content:encoded"]),
      }))
    : asArray(atomFeed.entry).map((entry) => ({
        title: textValue(entry.title),
        url: atomLink(entry),
        author: textValue(entry.author?.name ?? entry.author),
        publishedAt: textValue(entry.published ?? entry.updated),
        summary: textValue(entry.summary ?? entry.content),
      }));

  return entries
    .filter((entry) => entry.title && entry.url)
    .map((entry) => {
      const canonicalUrl = canonicalizeUrl(entry.url, feedUrl);
      const publishedAt = entry.publishedAt
        ? new Date(entry.publishedAt)
        : null;

      return {
        title: entry.title,
        canonicalUrl,
        author: entry.author || null,
        publishedAt:
          publishedAt && !Number.isNaN(publishedAt.valueOf())
            ? publishedAt.toISOString()
            : null,
        summary: entry.summary,
        contentHash: hashText(
          [canonicalUrl, entry.title, entry.summary].join("\n"),
        ),
      };
    });
}

export async function fetchFeed(
  feedUrl,
  {
    fetchImpl = fetch,
    timeoutMs = 15_000,
    maxBytes = MAX_FEED_BYTES,
  } = {},
) {
  const url = assertPublicHttpUrl(feedUrl);
  const response = await fetchImpl(url, {
    headers: {
      accept:
        "application/atom+xml, application/rss+xml, application/xml, text/xml",
      "user-agent": "telegram-news-agent/0.1",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Feed request failed with HTTP ${response.status}`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength && declaredLength > maxBytes) {
    throw new Error(`Feed exceeds ${maxBytes} bytes`);
  }

  const xml = await response.text();
  if (Buffer.byteLength(xml) > maxBytes) {
    throw new Error(`Feed exceeds ${maxBytes} bytes`);
  }

  return parseFeed(xml, url);
}
