import { createHash } from "node:crypto";
import { isIP, BlockList } from "node:net";

import { Inject, Injectable } from "@nestjs/common";
import * as cheerio from "cheerio";
import { XMLParser } from "fast-xml-parser";

import type { CatalogPersistence } from "../catalog/catalog-persistence.js";
import { CATALOG_PERSISTENCE } from "../catalog/catalog-persistence.tokens.js";
import type { UsageReportingPersistence } from "../usage/usage-persistence.contracts.js";
import { USAGE_REPORTING_PERSISTENCE } from "../usage/usage-persistence.tokens.js";
import type { DiscoveryEntry, FeedDiscoveryResult, FeedEntry, NewsSearchResult, SourceAcquisition, SourceAcquisitionClock, SourceAcquisitionDns, SourceAcquisitionTransport, SourceDiscoveryProvider } from "./source-acquisition.contracts.js";
import { SOURCE_ACQUISITION_CLOCK, SOURCE_ACQUISITION_DNS, SOURCE_ACQUISITION_TRANSPORT, SOURCE_DISCOVERY_PROVIDER } from "./source-acquisition.tokens.js";

const MAX_FEED_BYTES = 5 * 1024 * 1024;
const MAX_GDELT_BYTES = 2 * 1024 * 1024;
const MAX_DISCOVERED_FEEDS = 8;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BLOCKED_V4 = new BlockList();
for (const [network, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) BLOCKED_V4.addSubnet(network, prefix, "ipv4");
const BLOCKED_V6 = new BlockList();
for (const [network, prefix] of [["::", 96], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["2001:db8::", 32]] as const) BLOCKED_V6.addSubnet(network, prefix, "ipv6");

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function array<T>(value: T | T[] | null | undefined): T[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }
function text(value: unknown): string { if (typeof value === "string" || typeof value === "number") return String(value).trim(); if (value && typeof value === "object") return text((value as Record<string, unknown>)["#text"] ?? (value as Record<string, unknown>).__cdata); return ""; }
function canonicalize(value: string, base?: string): string { const url = new URL(value, base); url.hash = ""; for (const key of [...url.searchParams.keys()]) if (key.toLowerCase().startsWith("utm_") || ["fbclid", "gclid", "mc_cid", "mc_eid", "ref", "source"].includes(key.toLowerCase())) url.searchParams.delete(key); url.searchParams.sort(); return url.toString(); }
function labels(values: string[] | undefined): string[] { return [...new Set((values ?? []).map((v) => String(v).trim().toLowerCase()).filter(Boolean))].sort(); }
function keyFor(settings: { topicCodes?: string[]; customTopics?: string[] }): string { return hash(JSON.stringify({ topicCodes: labels(settings.topicCodes), customTopics: labels(settings.customTopics) })); }
function errorCode(error: unknown): string { const message = String(error instanceof Error ? error.message : error).toLowerCase(); const name=(error as {name?:unknown})?.name;const code=(error as {code?:unknown})?.code;const status = message.match(/http\s+(\d{3})/)?.[1]; if (status) return `http_${status}`; if (name==="AbortError"||code==="ABORT_ERR"||message.includes("timeout")||message==="aborted") return "timeout"; if (message.includes("unsupported feed") || message.includes("expected rss")) return "invalid_feed"; if (message.includes("exceeds") && message.includes("bytes")) return "response_too_large"; if (message.includes("private") || message.includes("public http")) return "unsafe_url"; return "fetch_failed"; }
function safeError(error: unknown): string { const value = String((error as { code?: string })?.code ?? "source_discovery_failed").toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 64); return value.length >= 2 ? value : "source_discovery_failed"; }
function mappedIpv4(address: string): string | null { const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1]; if (dotted) return dotted; const hex = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i); if (!hex) return null; const high = Number.parseInt(hex[1], 16); const low = Number.parseInt(hex[2], 16); return [high >> 8, high & 0xff, low >> 8, low & 0xff].join("."); }
function gdeltQuery(topicCodes: string[], customTopics: string[]): string { const mapping:Record<string,string[]>={ai:["artificial intelligence"],world:["international crisis","election","diplomacy","disaster"],science:["scientific discovery","research breakthrough"],nature:["climate change","biodiversity","ecosystem"],animals:["wildlife","endangered species"],history:["archaeological discovery","ancient history"],culture:["cultural heritage","literature","arts"],technology:["technology","innovation","engineering"],society:["public health","education","human development"]};const terms = [...customTopics, ...topicCodes.flatMap((code) => mapping[code] ?? [])].map((v) => String(v).normalize("NFKC").replace(/[^\p{L}\p{N}\p{M}\s-]/gu, " ").trim().replace(/\s+/g, " ").slice(0, 60)).filter((v) => v.length >= 2).map((v) => v.includes(" ") ? `"${v}"` : v); return terms.length ? `(${[...new Set(terms)].slice(0, 16).join(" OR ")})` : "breaking news"; }

@Injectable()
export class SourceAcquisitionGateway implements SourceAcquisition {
  constructor(
    @Inject(CATALOG_PERSISTENCE) private readonly catalog: CatalogPersistence,
    @Inject(USAGE_REPORTING_PERSISTENCE) private readonly usage: UsageReportingPersistence,
    @Inject(SOURCE_ACQUISITION_TRANSPORT) private readonly transport: SourceAcquisitionTransport,
    @Inject(SOURCE_ACQUISITION_DNS) private readonly dns: SourceAcquisitionDns,
    @Inject(SOURCE_ACQUISITION_CLOCK) private readonly clock: SourceAcquisitionClock,
    @Inject(SOURCE_DISCOVERY_PROVIDER) private readonly provider: SourceDiscoveryProvider | null,
  ) {}

  private async recordUsage(
    usageEvents: Awaited<ReturnType<SourceDiscoveryProvider["searchNews"]>>["usageEvents"],
    channelId: string | null | undefined,
    searchRunId: string | null | undefined,
  ): Promise<void> {
    for (const event of usageEvents ?? []) {
      if (!event) continue;
      try {
        await this.usage.recordAiUsage({
          ...event,
          pricingSnapshot: event.pricingSnapshot ?? event.pricing ?? null,
          telegramChannelId: channelId ?? null,
          searchRunId: searchRunId ?? null,
        });
      } catch {
        // Usage telemetry must never turn a successful discovery into a failure.
      }
    }
  }

  private async retry<T>(operation: () => Promise<T>, attempts: number, baseDelayMs: number): Promise<T> {
    let failure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        failure = error;
        if (attempt < attempts) await this.clock.sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
    throw failure;
  }

  private assertUrl(value: string | URL): URL { const url = value instanceof URL ? value : new URL(value); const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase(); if (!["http:", "https:"].includes(url.protocol)) throw new Error(`Unsupported URL protocol: ${url.protocol}`); if (url.username || url.password) throw new Error("URL credentials are not allowed"); if (host === "localhost" || host.endsWith(".localhost")) throw new Error(`Private or loopback URL is not allowed: ${host}`); if (isIP(host)) this.assertIp(host); return url; }
  private assertIp(address: string): void { const family = isIP(address); if (!family) throw new Error(`DNS returned an invalid address: ${address}`); const mapped = family === 6 ? mappedIpv4(address) : null; if (family === 4 ? BLOCKED_V4.check(address, "ipv4") : mapped ? BLOCKED_V4.check(mapped, "ipv4") : BLOCKED_V6.check(address, "ipv6")) throw new Error(`Private, reserved, or link-local address is not allowed: ${address}`); }
  private async safeFetch(value: string | URL, init: RequestInit, maxRedirects: number): Promise<{ response: Response; finalUrl: URL }> { let url = this.assertUrl(value); for (let redirects = 0;; redirects += 1) { const host = url.hostname.replace(/^\[|\]$/g, ""); const family=isIP(host);const addresses=family?[{address:host,family:family as 4|6}]:await this.dns.lookup(host);if(!addresses.length)throw new Error(`DNS returned no addresses for ${host}`);addresses.forEach(({address})=>this.assertIp(address));const response=await this.transport.fetchPinned(url,{...init,redirect:"manual"},addresses);if(!REDIRECTS.has(response.status))return{response,finalUrl:url};if(redirects>=maxRedirects)throw new Error(`Request exceeded ${maxRedirects} redirects`);const location=response.headers.get("location");if(!location)throw new Error(`Redirect response ${response.status} has no location`);await response.body?.cancel();url=this.assertUrl(new URL(location,url));} }

  async fetchFeed(feedUrl: string): Promise<FeedEntry[]> { const { response, finalUrl } = await this.safeFetch(feedUrl, { headers: { accept: "application/atom+xml, application/rss+xml, application/xml, text/xml", "user-agent": "telegram-news-agent/0.1" }, signal: AbortSignal.timeout(15_000) }, 5); if (!response.ok) throw new Error(`Feed request failed with HTTP ${response.status}`); const declared = Number(response.headers.get("content-length")); if (declared && declared > MAX_FEED_BYTES) throw new Error(`Feed exceeds ${MAX_FEED_BYTES} bytes`); const xml = await response.text(); if (Buffer.byteLength(xml) > MAX_FEED_BYTES) throw new Error(`Feed exceeds ${MAX_FEED_BYTES} bytes`); const parsed = new XMLParser({ ignoreAttributes:false, attributeNamePrefix:"@_", textNodeName:"#text", cdataPropName:"__cdata", trimValues:true, parseTagValue:false, processEntities:{enabled:true,maxEntityCount:50,maxExpandedLength:50_000} }).parse(xml) as Record<string, unknown>; const rss = (parsed.rss as { channel?: { item?: unknown } } | undefined)?.channel; const atom = parsed.feed as { entry?: unknown } | undefined; if (!rss && !atom) throw new Error("Unsupported feed: expected RSS 2.0 or Atom"); const raw = rss ? array(rss.item).map((item) => { const r = item as Record<string, unknown>; return { title:text(r.title), url:text(r.link) || text(r.guid), author:text(r.author ?? r["dc:creator"]), publishedAt:text(r.pubDate ?? r["dc:date"]), summary:text(r.description ?? r["content:encoded"]) }; }) : array(atom?.entry).map((item) => { const r = item as Record<string, unknown>; const links = array<Record<string, unknown>>(r.link as Record<string, unknown> | Record<string, unknown>[] | null); const link = links.find((l) => l["@_rel"] === "alternate") ?? links[0]; return { title:text(r.title), url:typeof link === "string" ? link : text(link?.["@_href"]), author:text((r.author as Record<string, unknown> | undefined)?.name ?? r.author), publishedAt:text(r.published ?? r.updated), summary:text(r.summary ?? r.content) }; }); return raw.filter((entry) => entry.title && entry.url).map((entry) => { const canonicalUrl = canonicalize(entry.url, finalUrl.toString()); const date = entry.publishedAt ? new Date(entry.publishedAt) : null; return { title:entry.title, canonicalUrl, author:entry.author || null, publishedAt:date && !Number.isNaN(date.valueOf()) ? date.toISOString() : null, summary:entry.summary, contentHash:hash([canonicalUrl, entry.title, entry.summary].join("\n")) }; }); }

  async fetchSourceFeed(input: { sourceId: string; feedUrl: string }): Promise<FeedEntry[]> {
    return await this.fetchWithHealth(input.sourceId, () => this.fetchFeed(input.feedUrl), 3, 300);
  }

  async fetchSource(input: { sourceId: string; sourceType: "rss" | "reddit" | "gdelt"; feedUrl: string; topicCodes?: string[]; customTopics?: string[]; windowHours?: number }): Promise<Array<FeedEntry | DiscoveryEntry>> {
    if (input.sourceType === "reddit") return await this.fetchWithHealth(input.sourceId, () => this.fetchReddit(input.feedUrl), 3, 300);
    if (input.sourceType === "gdelt") return await this.fetchWithHealth(input.sourceId, () => this.fetchGdelt({ apiUrl:input.feedUrl, topicCodes:input.topicCodes, customTopics:input.customTopics, windowHours:input.windowHours }), 2, 5_500);
    return await this.fetchWithHealth(input.sourceId, () => this.fetchFeed(input.feedUrl), 3, 300);
  }

  private async fetchWithHealth<T>(sourceId: string, operation: () => Promise<T>, attempts: number, baseDelayMs: number): Promise<T> {
    try {
      const result = await this.retry(operation, attempts, baseDelayMs);
      await this.catalog.markSourceFetchSuccess(sourceId);
      return result;
    } catch (error) {
      await this.catalog.markSourceFetchFailure(sourceId, errorCode(error));
      throw error;
    }
  }

  async fetchReddit(feedUrl: string): Promise<DiscoveryEntry[]> { const entries = await this.fetchFeed(feedUrl); return entries.flatMap((entry) => { const $ = cheerio.load(entry.summary ?? ""); const urls = new Set<string>(); $("a[href]").each((_i, element) => { try { const url = new URL($(element).attr("href") ?? ""); if (["http:", "https:"].includes(url.protocol) && !(url.hostname === "reddit.com" || url.hostname.endsWith(".reddit.com"))) { url.hash = ""; urls.add(url.toString()); } } catch { /* untrusted user markup */ } }); const candidates = urls.size ? [...urls] : [entry.canonicalUrl]; return candidates.map((canonicalUrl) => ({ ...entry, canonicalUrl, contentHash:hash([canonicalUrl, entry.title, entry.summary].join("\n")), discoveryUrl:entry.canonicalUrl, discoveryKind:"reddit" as const, unverified:true })); }); }

  async fetchGdelt(input: { apiUrl?: string; topicCodes?: string[]; customTopics?: string[]; windowHours?: number; maxRecords?: number }): Promise<DiscoveryEntry[]> { const endpoint = this.assertUrl(input.apiUrl ?? "https://api.gdeltproject.org/api/v2/doc/doc"); endpoint.search = ""; endpoint.searchParams.set("query", gdeltQuery(input.topicCodes ?? [], input.customTopics ?? [])); endpoint.searchParams.set("mode", "ArtList"); endpoint.searchParams.set("format", "json"); endpoint.searchParams.set("sort", "HybridRel"); endpoint.searchParams.set("maxrecords", String(Math.max(1, Math.min(250, Number(input.maxRecords) || 75)))); const hours = Math.max(1, Math.min(24 * 365, Number(input.windowHours) || 48)); endpoint.searchParams.set("timespan", hours <= 72 ? `${Math.ceil(hours)}h` : `${Math.ceil(hours / 24)}d`); const { response, finalUrl } = await this.safeFetch(endpoint, { headers:{accept:"application/json", "user-agent":"telegram-news-agent/0.1 (personal news reader)"}, signal:AbortSignal.timeout(25_000) }, 3); if (!response.ok) throw new Error(`GDELT request failed with HTTP ${response.status}`); const declared = Number(response.headers.get("content-length")); if (declared && declared > MAX_GDELT_BYTES) throw new Error(`GDELT response exceeds ${MAX_GDELT_BYTES} bytes`); const body = await response.text(); if (Buffer.byteLength(body) > MAX_GDELT_BYTES) throw new Error(`GDELT response exceeds ${MAX_GDELT_BYTES} bytes`); let articles: unknown[]; try { articles = Array.isArray((JSON.parse(body) as { articles?: unknown[] }).articles) ? (JSON.parse(body) as { articles: unknown[] }).articles : []; } catch { throw new Error("GDELT returned invalid JSON"); } const discovered: DiscoveryEntry[] = []; for (const item of articles) try { const article = item as Record<string, unknown>; const title = String(article.title ?? "").trim(); if (!title) continue; const canonicalUrl = canonicalize(this.assertUrl(String(article.url ?? "")).toString()); const seen = String(article.seendate ?? ""); const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(seen); const publishedAt = match ? new Date(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`).toISOString() : null; discovered.push({ title, canonicalUrl, author:null, publishedAt, summary:title, publisher:String(article.domain ?? "").trim() || new URL(canonicalUrl).hostname.replace(/^www\./, ""), language:String(article.language ?? "").trim() || null, sourceCountry:String(article.sourcecountry ?? "").trim() || null, contentHash:hash([canonicalUrl, title].join("\n")), discoveryKind:"gdelt", discoveryUrl:finalUrl.toString(), verificationStatus:"web_source" }); } catch { /* GDELT index input is untrusted */ } return discovered; }

  async searchNews(input: {
    query: string;
    windowHours: number;
    limit?: number;
    languageCode?: string;
    topicCodes?: string[];
    customTopics?: string[];
    excludedTopics?: Array<{ code: string; name: string; description?: string }>;
    channelId?: string | null;
    searchRunId?: string | null;
  }): Promise<NewsSearchResult> {
    if (!this.provider) throw Object.assign(new Error("News discovery provider is unavailable"), { code: "provider_unavailable" });
    const discovery = await this.provider.searchNews({
      query: String(input.query ?? ""),
      windowHours: Math.max(1, Math.min(24 * 30, Number(input.windowHours) || 48)),
      limit: Math.max(1, Math.min(10, Number(input.limit) || 8)),
      ...(input.languageCode ? { languageCode: input.languageCode } : {}),
      ...(input.topicCodes ? { topicCodes: [...input.topicCodes] } : {}),
      ...(input.customTopics ? { customTopics: [...input.customTopics] } : {}),
      ...(input.excludedTopics ? { excludedTopics: input.excludedTopics.map((topic) => ({ ...topic })) } : {}),
    });
    if (!["openai", "gemini", "exa"].includes(discovery.provider)) throw new Error("News discovery returned an unsupported provider");
    await this.recordUsage(discovery.usageEvents, input.channelId, input.searchRunId);
    const items = (discovery.items ?? []).flatMap((item, searchRank) => {
      try {
        const canonicalUrl = canonicalize(this.assertUrl(item.url).toString());
        const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null;
        return [{
          title: String(item.title ?? "").trim(),
          canonicalUrl,
          author: String(item.author ?? "").trim() || null,
          publishedAt: publishedAt && !Number.isNaN(publishedAt.valueOf()) ? publishedAt.toISOString() : null,
          summary: String(item.summary ?? "").trim(),
          contentHash: hash([canonicalUrl, item.title, item.summary].join("\n")),
          discoveryKind: `${discovery.provider}_web_search` as const,
          provider: discovery.provider,
          model: discovery.model ?? null,
          searchRank,
          languageCode: input.languageCode ?? null,
          verificationStatus: "web_source" as const,
        }];
      } catch {
        return [];
      }
    }).filter((item) => item.title && item.summary);
    return { provider: discovery.provider, model: discovery.model ?? null, items, usageEvents: discovery.usageEvents ?? [] };
  }

  async discoverFeeds(input: { newsSettings: { channelId?: string | null; languageCode?: string; topicCodes?: string[]; customTopics?: string[] }; searchRunId?: string | null }): Promise<FeedDiscoveryResult> { if (!this.provider) return { status:"unsupported", sources:[], usageEvents:[] }; const settings = input.newsSettings; const topicKey = keyFor(settings); if (!await this.catalog.claimSourceDiscovery(topicKey)) return { status:"cooldown", topicKey, sources:[], usageEvents:[] }; let provider: string | null = null; let model: string | null = null; try { const discovery = await this.provider.searchFeeds({ topicCodes:[...(settings.topicCodes ?? [])], customTopics:[...(settings.customTopics ?? [])], languageCode:settings.languageCode ?? "en", limit:MAX_DISCOVERED_FEEDS }); provider = discovery.provider; model = discovery.model; if (!["openai", "gemini", "exa"].includes(provider)) throw new Error("Feed discovery returned an unsupported provider"); await this.recordUsage(discovery.usageEvents, settings.channelId, input.searchRunId); const sources: FeedDiscoveryResult["sources"] = []; const failures: Array<{feed_url:string;error_code:string}> = []; const seen = new Set<string>(); for (const item of discovery.items ?? []) { let feedUrl: string | undefined; try { const normalized = this.assertUrl(item.feedUrl); normalized.hash = ""; normalized.searchParams.sort(); feedUrl = normalized.toString(); if (seen.has(feedUrl)) continue; seen.add(feedUrl); const entries = await this.retry(() => this.fetchFeed(feedUrl as string), 2, 500); if (!entries.length) throw new Error("Validated feed contains no entries"); const homepageUrl = item.homepageUrl ? this.assertUrl(item.homepageUrl).toString() : new URL(feedUrl).origin; const saved = await this.catalog.upsertDiscoveredSource({ name:item.name, homepageUrl, feedUrl, reliabilityScore:65, topicCodes:[...(settings.topicCodes ?? [])], discoveredBy:provider, discoveryMetadata:{custom_topics:[...(settings.customTopics ?? [])], language_code:settings.languageCode ?? "en", discovered_at:this.clock.now().toISOString()} }); sources.push({ source:{...saved, topic_codes:[...(settings.topicCodes ?? [])]}, entries }); } catch (error) { failures.push({ feed_url:feedUrl ?? String(item.feedUrl ?? ""), error_code:errorCode(error) }); } } await this.catalog.completeSourceDiscovery({ topicKey, provider, model, resultCount:sources.length, errorCode:null }); return { status:"completed", topicKey, provider, model, sources, failures, usageEvents:discovery.usageEvents ?? [] }; } catch (error) { const code = safeError(error); await this.catalog.completeSourceDiscovery({ topicKey, provider, model, resultCount:0, errorCode:code }); return { status:"failed", topicKey, provider, model, sources:[], failures:[], error:code, usageEvents:[] }; } }
}
