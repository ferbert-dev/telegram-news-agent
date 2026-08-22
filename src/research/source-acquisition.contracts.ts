import type { RecordAiUsageInput } from "../usage/usage-persistence.contracts.js";

export type SourceDiscoveryItem = {
  name: string;
  feedUrl: string;
  homepageUrl?: string | null;
};

export type SourceDiscoveryResponse = {
  provider: "openai" | "gemini" | "exa";
  model: string | null;
  items: SourceDiscoveryItem[];
  usageEvents: RecordAiUsageInput[];
};

export type NewsDiscoveryItem = {
  title: string;
  url: string;
  summary: string;
  publishedAt?: string | null;
  author?: string | null;
};

export type NewsDiscoveryResponse = {
  provider: "openai" | "gemini" | "exa";
  model: string | null;
  items: NewsDiscoveryItem[];
  usageEvents: RecordAiUsageInput[];
};

export interface SourceDiscoveryProvider {
  searchFeeds(input: {
    topicCodes: string[];
    customTopics: string[];
    languageCode: string;
    limit: number;
  }): Promise<SourceDiscoveryResponse>;
  searchNews(input: {
    query: string;
    windowHours: number;
    limit: number;
    languageCode?: string;
    topicCodes?: string[];
    customTopics?: string[];
    excludedTopics?: Array<{ code: string; name: string; description?: string }>;
  }): Promise<NewsDiscoveryResponse>;
}

export interface SourceAcquisitionTransport {
  fetch(url: URL, init: RequestInit): Promise<Response>;
}

export type DnsAddress = { address: string; family: 4 | 6 };
export interface SourceAcquisitionDns {
  lookup(hostname: string): Promise<DnsAddress[]>;
}

export interface SourceAcquisitionClock {
  now(): Date;
  sleep(delayMs: number): Promise<void>;
}

export type FeedEntry = {
  title: string;
  canonicalUrl: string;
  author: string | null;
  publishedAt: string | null;
  summary: string;
  contentHash: string;
};

export type DiscoveryEntry = FeedEntry & {
  publisher?: string;
  language?: string | null;
  sourceCountry?: string | null;
  discoveryUrl: string;
  discoveryKind: "gdelt" | "reddit";
  verificationStatus?: "web_source";
  unverified?: boolean;
};

export type NewsDiscoveryEntry = FeedEntry & {
  discoveryKind: `${"openai" | "gemini" | "exa"}_web_search`;
  provider: "openai" | "gemini" | "exa";
  model: string | null;
  searchRank: number;
  languageCode: string | null;
  verificationStatus: "web_source";
};

export type NewsSearchResult = {
  provider: "openai" | "gemini" | "exa";
  model: string | null;
  items: NewsDiscoveryEntry[];
  usageEvents: RecordAiUsageInput[];
};

export type FeedDiscoveryResult = {
  status: "unsupported" | "cooldown" | "completed" | "failed";
  topicKey?: string;
  provider?: string | null;
  model?: string | null;
  sources: Array<{ source: Record<string, unknown>; entries: FeedEntry[] }>;
  failures?: Array<{ feed_url: string; error_code: string }>;
  error?: string;
  usageEvents: RecordAiUsageInput[];
};

export interface SourceAcquisition {
  fetchFeed(feedUrl: string): Promise<FeedEntry[]>;
  fetchSourceFeed(input: { sourceId: string; feedUrl: string }): Promise<FeedEntry[]>;
  fetchSource(input: {
    sourceId: string;
    sourceType: "rss" | "reddit" | "gdelt";
    feedUrl: string;
    topicCodes?: string[];
    customTopics?: string[];
    windowHours?: number;
  }): Promise<Array<FeedEntry | DiscoveryEntry>>;
  fetchReddit(feedUrl: string): Promise<DiscoveryEntry[]>;
  fetchGdelt(input: {
    apiUrl?: string;
    topicCodes?: string[];
    customTopics?: string[];
    windowHours?: number;
    maxRecords?: number;
  }): Promise<DiscoveryEntry[]>;
  searchNews(input: {
    query: string;
    windowHours: number;
    limit?: number;
    languageCode?: string;
    topicCodes?: string[];
    customTopics?: string[];
    excludedTopics?: Array<{ code: string; name: string; description?: string }>;
    channelId?: string | null;
    searchRunId?: string | null;
  }): Promise<NewsSearchResult>;
  discoverFeeds(input: {
    newsSettings: {
      channelId?: string | null;
      languageCode?: string;
      topicCodes?: string[];
      customTopics?: string[];
    };
    searchRunId?: string | null;
  }): Promise<FeedDiscoveryResult>;
}
