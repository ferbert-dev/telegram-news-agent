import { Inject, Injectable } from "@nestjs/common";

import type {
  ArticleTagRow,
  CatalogPersistence,
  CompleteSourceDiscoveryInput,
  SourceRow,
  SourceWithTopics,
  UpsertDiscoveredSourceInput,
  UpsertSourceInput,
} from "../catalog-persistence.js";
import { CATALOG_PERSISTENCE } from "../catalog-persistence.tokens.js";

/**
 * Transport-neutral facade for the source catalogue and its atomic health and
 * discovery transitions. Inputs, nullable results, and persistence errors are
 * deliberately passed through unchanged during the strangler migration.
 */
@Injectable()
export class CatalogService implements CatalogPersistence {
  constructor(
    @Inject(CATALOG_PERSISTENCE)
    private readonly catalog: CatalogPersistence,
  ) {}

  listEnabledSources(): Promise<SourceWithTopics[]> {
    return this.catalog.listEnabledSources();
  }

  listEnabledArticleTags(languageCode: string): Promise<ArticleTagRow[]> {
    return this.catalog.listEnabledArticleTags(languageCode);
  }

  listSourceHealth(): Promise<SourceWithTopics[]> {
    return this.catalog.listSourceHealth();
  }

  upsertSource(input: UpsertSourceInput): Promise<SourceRow> {
    return this.catalog.upsertSource(input);
  }

  setSourceEnabled(id: string, enabled: boolean): Promise<SourceRow> {
    return this.catalog.setSourceEnabled(id, enabled);
  }

  markSourceChecked(id: string): Promise<SourceRow> {
    return this.catalog.markSourceChecked(id);
  }

  markSourceFetchSuccess(id: string): Promise<SourceRow> {
    return this.catalog.markSourceFetchSuccess(id);
  }

  markSourceFetchFailure(
    id: string,
    errorCode: string,
  ): Promise<SourceRow> {
    return this.catalog.markSourceFetchFailure(id, errorCode);
  }

  claimSourceDiscovery(topicKey: string): Promise<boolean> {
    return this.catalog.claimSourceDiscovery(topicKey);
  }

  completeSourceDiscovery(
    input: CompleteSourceDiscoveryInput,
  ): Promise<boolean> {
    return this.catalog.completeSourceDiscovery(input);
  }

  upsertDiscoveredSource(
    input: UpsertDiscoveredSourceInput,
  ): Promise<SourceRow> {
    return this.catalog.upsertDiscoveredSource(input);
  }
}
