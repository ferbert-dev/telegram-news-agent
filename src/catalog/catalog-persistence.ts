export type SourceRow = {
  id: string;
  name: string;
  homepage_url: string | null;
  feed_url: string | null;
  source_type: string;
  reliability_score: number | null;
  enabled: boolean;
  last_checked_at: string | null;
  created_at: string;
  updated_at: string;
  is_primary: boolean;
  last_success_at: string | null;
  last_failed_at: string | null;
  consecutive_failures: number;
  last_error_code: string | null;
  disabled_until: string | null;
  discovered_by: string;
  discovery_metadata: Record<string, unknown>;
};

export type SourceWithTopics = SourceRow & {
  topic_codes: string[];
};

export type ArticleTagRow = {
  topic_id: string;
  code: string;
  description: string | null;
  language_code: string;
  label: string;
  hashtag: string;
};

export type UpsertSourceInput = {
  name: string;
  feed_url: string;
  source_type: string;
  homepage_url?: string | null;
  reliability_score?: number | null;
  enabled?: boolean;
  is_primary?: boolean;
  last_checked_at?: string | null;
};

export type CompleteSourceDiscoveryInput = {
  topicKey: string;
  provider?: string | null;
  model?: string | null;
  resultCount?: number;
  errorCode?: string | null;
};

export type UpsertDiscoveredSourceInput = {
  name: string;
  homepageUrl: string | null;
  feedUrl: string;
  reliabilityScore?: number;
  topicCodes?: string[];
  discoveredBy: string;
  discoveryMetadata?: Record<string, unknown>;
};

/**
 * Narrow Catalog persistence boundary. The five methods that coordinate
 * health or discovery transitions remain atomic PostgreSQL functions inside
 * the implementation; consumers only depend on this behavior-level contract.
 */
export interface CatalogPersistence {
  listEnabledSources(): Promise<SourceWithTopics[]>;
  listEnabledArticleTags(languageCode: string): Promise<ArticleTagRow[]>;
  listSourceHealth(): Promise<SourceWithTopics[]>;
  upsertSource(input: UpsertSourceInput): Promise<SourceRow>;
  setSourceEnabled(id: string, enabled: boolean): Promise<SourceRow>;
  markSourceChecked(id: string): Promise<SourceRow>;
  markSourceFetchSuccess(id: string): Promise<SourceRow>;
  markSourceFetchFailure(id: string, errorCode: string): Promise<SourceRow>;
  claimSourceDiscovery(topicKey: string): Promise<boolean>;
  completeSourceDiscovery(
    input: CompleteSourceDiscoveryInput,
  ): Promise<boolean>;
  upsertDiscoveredSource(
    input: UpsertDiscoveredSourceInput,
  ): Promise<SourceRow>;
}
