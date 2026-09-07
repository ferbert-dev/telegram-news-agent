import type { EditorialDraftGenerationResult } from "./editorial-application.contracts.js";
import type {
  EditorialDraftGateway,
  EditorialEvidence,
  GenerateReviewDraftInput,
} from "./editorial-application.contracts.js";
import {
  generateDraft as legacyGenerateDraft,
  validateGroundedDraft as legacyValidateGroundedDraft,
} from "../draft.js";
import { measureEditorialSimilarity as legacyMeasureEditorialSimilarity } from "../editorial-enrichment.js";
import type { CreateReviewDraftInput } from "./editorial-persistence.contracts.js";
import type { RecordAiUsageInput } from "../usage/usage-persistence.contracts.js";
import type {
  ArticleTopicAssignment,
  ArticleTopicAssignmentSource,
} from "../research/research-persistence.contracts.js";
import type { EvidenceCorroborationService } from "./corroboration/evidence-corroboration.service.js";
import type { FactPlanService } from "./corroboration/fact-plan.service.js";
import { factSearchCorroborationPort } from "./corroboration/fact-search.adapter.js";
import type {
  EditorialEnrichmentService,
} from "./enrichment/editorial-enrichment.service.js";
import type {
  EditorialEnrichmentPorts,
  EnrichedArticle,
} from "./enrichment/editorial-enrichment.contracts.js";

/**
 * The legacy seam for the typed editorial pass, in the file that is allowed to
 * hold one. Grounding stays the single implementation production already uses.
 */
export const LEGACY_EDITORIAL_ENRICHMENT_PORTS: EditorialEnrichmentPorts = {
  validateDraft: legacyValidateGroundedDraft as EditorialEnrichmentPorts["validateDraft"],
  measureSimilarity:
    legacyMeasureEditorialSimilarity as EditorialEnrichmentPorts["measureSimilarity"],
};
import { appendEditorCredit } from "../editor.js";
import { appendTopicHashtags } from "../article-tags.js";
import { validateMessage } from "../telegram.js";

const ARTICLE_TAGS_FEATURE_KEY = "article_tags";
const EDITORIAL_ENRICHMENT_FEATURE_KEY = "editorial_enrichment";

type NewsSettingsSnapshot = {
  channelId?: string | null;
  languageCode?: string;
};

type FeatureFlagRow = {
  feature_key?: string;
  state?: string;
};

type ArticleTag = {
  code: string;
  label?: string;
  description?: string;
};

type ArticleTagging = {
  state: "off" | "collect" | "enabled";
  catalog: ArticleTag[];
};

type LegacyDraftRepository = {
  getNewsFeatureFlags?: (channelId: string) => Promise<FeatureFlagRow[]>;
  listEnabledArticleTags?: (languageCode: string) => Promise<ArticleTag[]>;
  createReviewDraft: (draft: CreateReviewDraftInput) => Promise<unknown>;
  recordAiUsage?: (input: RecordAiUsageInput) => Promise<unknown>;
};

type LegacyGenerateDraftResult = {
  draft: {
    telegramText: string;
    [key: string]: unknown;
  };
  baselineDraft: unknown;
  enrichedDraft: unknown | null;
  editorialEnrichment: unknown;
  saved: {
    article_id: string;
    body: string;
    model: string | null;
    prompt_version: string | null;
    reviewer_notes: string | null;
    lease_name?: string | null;
    lease_owner_id?: string | null;
    topic_assignments?: ArticleTopicAssignment[] | null;
    topic_assignment_source?: ArticleTopicAssignmentSource | null;
    topic_assigned_model?: string | null;
  };
  provider: string;
  model: string;
};

type GenerateDraftFunction = (
  args: {
    aiProvider: unknown;
    client?: unknown;
    model: string;
    repository: LegacyDraftRepository;
    article: GenerateReviewDraftInput["article"];
    evidence: GenerateReviewDraftInput["evidence"];
    allowUnverified?: boolean;
    lease?: GenerateReviewDraftInput["lease"];
    languageCode: GenerateReviewDraftInput["languageCode"];
    newsSettings?: unknown;
    editor?: unknown;
    articleTagging: ArticleTagging;
    editorialEnrichment: { state: "off" | "collect" | "enabled" };
  },
  signal?: AbortSignal,
) => Promise<LegacyGenerateDraftResult>;

function featureState(row: unknown): "off" | "collect" | "enabled" {
  if (!row || typeof row !== "object") {
    return "off";
  }
  const state = (row as { state?: unknown }).state;
  return state === "collect" || state === "enabled" ? state : "off";
}

function buildGenerationRepositoryFacade(
  repository: LegacyDraftRepository,
  usageEvents: RecordAiUsageInput[],
) {
  return new Proxy(repository, {
    get(target, property) {
      if (property === "createReviewDraft") {
        return async (draft: CreateReviewDraftInput) => {
          return {
            id: `legacy-generated-draft-${draft.article_id}`,
            article_id: draft.article_id,
            body: draft.body,
            status: "review",
            model: draft.model ?? null,
            prompt_version: draft.prompt_version ?? null,
            reviewer_notes: draft.reviewer_notes ?? null,
            approved_at: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          } as const;
        };
      }
      if (property === "recordAiUsage") {
        return async (usage: RecordAiUsageInput) => {
          usageEvents.push(usage);
          return {
            id: `legacy-usage-${usage.operation ?? "editorial"}`,
            provider: usage.provider,
            provider_response_id: usage.providerResponseId ?? null,
            model: usage.model,
            operation: usage.operation,
            telegram_channel_id: usage.telegramChannelId ?? null,
            search_run_id: usage.searchRunId ?? null,
            article_id: usage.articleId ?? null,
            input_tokens: usage.inputTokens ?? 0,
            cached_input_tokens: usage.cachedInputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            reasoning_tokens: usage.reasoningTokens ?? 0,
            web_search_calls: usage.webSearchCalls ?? 0,
            estimated_cost_usd: usage.estimatedCostUsd ?? null,
            pricing_snapshot: usage.pricingSnapshot ?? null,
            created_at: new Date().toISOString(),
          } as never;
        };
      }

      const value = Reflect.get(target, property, repository);
      if (typeof value !== "function") {
        return value;
      }
      return value.bind(target);
    },
  });
}

function extractFeatureRows(value: unknown): FeatureFlagRow[] {
  if (!value || typeof value !== "object") return [];
  if (!Object.prototype.hasOwnProperty.call(value, "featureFlags")) return [];
  const candidate = (value as { featureFlags?: unknown }).featureFlags;
  return Array.isArray(candidate) ? (candidate as FeatureFlagRow[]) : [];
}

function buildEffectiveNewsSettings(
  settingsSnapshot: unknown,
  fallbackChannelId: string | null | undefined,
  fallbackLanguageCode: GenerateReviewDraftInput["languageCode"],
): NewsSettingsSnapshot {
  const base =
    settingsSnapshot && typeof settingsSnapshot === "object"
      ? (settingsSnapshot as NewsSettingsSnapshot)
      : {};
  const effectiveChannelId = base.channelId ?? fallbackChannelId ?? null;
  const effectiveLanguageCode = base.languageCode ?? fallbackLanguageCode;
  if (
    (base.channelId ?? null) === effectiveChannelId &&
    (base.languageCode ?? null) === effectiveLanguageCode
  ) {
    return base;
  }
  return {
    ...base,
    channelId: effectiveChannelId,
    languageCode: effectiveLanguageCode,
  };
}

async function resolveFeatureFlags(
  channelId: string | null | undefined,
  provided: unknown,
  repository: LegacyDraftRepository,
): Promise<FeatureFlagRow[]> {
  if (Array.isArray(provided)) {
    return provided as FeatureFlagRow[];
  }
  if (!provided || typeof provided !== "object") {
    const loadFeatureFlags = repository.getNewsFeatureFlags;
    if (channelId && typeof loadFeatureFlags === "function") {
      return loadFeatureFlags(channelId);
    }
    return [];
  }
  if (Object.prototype.hasOwnProperty.call(
    provided as object | null | undefined,
    "featureFlags",
  )) {
    const featureFlags = extractFeatureRows(provided);
    if (featureFlags.length > 0 || Array.isArray((provided as { featureFlags?: unknown }).featureFlags)) {
      return featureFlags;
    }
  }
  const loadFeatureFlags = repository.getNewsFeatureFlags;
  if (channelId && typeof loadFeatureFlags === "function") {
    return loadFeatureFlags(channelId);
  }
  return [];
}

async function resolveArticleTagging(
  settings: NewsSettingsSnapshot,
  repository: LegacyDraftRepository,
  featureFlags: FeatureFlagRow[],
): Promise<ArticleTagging> {
  const channelId = settings?.channelId ?? null;
  if (!channelId) return { state: "off", catalog: [] };

  const state = featureState(
    featureFlags.find((row) => row?.feature_key === ARTICLE_TAGS_FEATURE_KEY),
  );
  if (state === "off") {
    return { state, catalog: [] };
  }
  if (typeof repository.listEnabledArticleTags !== "function") {
    throw new Error("Article tag catalog is unavailable");
  }

  const catalog = await repository.listEnabledArticleTags(
    String(settings.languageCode ?? "en"),
  );
  if (!Array.isArray(catalog) || catalog.length === 0) {
    throw new Error("No enabled article tags are configured");
  }
  return { state, catalog };
}

function resolveEditorialEnrichment(
  featureFlags: FeatureFlagRow[],
  settings: NewsSettingsSnapshot,
) {
  if (!settings?.channelId) {
    return { state: "off" as const };
  }
  return {
    state: featureState(
      featureFlags.find(
        (row) => row?.feature_key === EDITORIAL_ENRICHMENT_FEATURE_KEY,
      ),
    ),
  };
}

export type LegacyEditorialDraftGatewayDependencies = {
  aiProvider?: unknown;
  client?: unknown;
  model: string;
  repository: LegacyDraftRepository;
  editor?: unknown;
  /**
   * Both optional. Absent, the gateway behaves exactly as it did before
   * corroboration existed -- which is what keeps this change safe to deploy
   * before it is switched on anywhere.
   */
  factPlan?: FactPlanService;
  corroboration?: EvidenceCorroborationService;
  /**
   * Optional, like the two above: absent, the article is the baseline and the
   * gateway behaves as it did before a typed editorial pass existed.
   */
  enrichment?: EditorialEnrichmentService;
};

/** Any unverified item makes the whole set unverified, as draft.js decides it. */
function isUnverified(evidence: readonly { verificationStatus?: string | null }[]): boolean {
  return evidence.some(
    (item) => (item.verificationStatus ?? "") === "unverified_community",
  );
}

type EditorialPassResult = {
  draft: EnrichedArticle | null;
  body: string | null;
  summary: Record<string, unknown>;
};

/**
 * Replaces the `editorial_enrichment` block legacy wrote with what actually
 * happened, leaving the rest of its reviewer notes untouched.
 *
 * Legacy was told the pass was off, so its own block says "disabled" -- which
 * would be a false record of a run where the pass ran here and succeeded.
 */
function withEnrichmentNotes(
  notes: string | null | undefined,
  pass: EditorialPassResult,
): string | null {
  if (!notes) return notes ?? null;
  // Nothing to say when the pass never ran. Writing a block for a disabled
  // feature would put our record over legacy's for a decision legacy made,
  // and would invent an editorial_enrichment key on notes that had none.
  if (pass.summary.status === "disabled") return notes;
  try {
    const parsed = JSON.parse(notes) as Record<string, unknown>;
    parsed.editorial_enrichment = pass.summary;
    return JSON.stringify(parsed);
  } catch {
    // Unparseable notes are legacy's to own; replacing them with our own
    // shape would lose whatever they did contain.
    return notes;
  }
}

export class LegacyEditorialDraftGateway implements EditorialDraftGateway {
  private readonly generateDraft: GenerateDraftFunction;

  constructor(
    private readonly dependencies: LegacyEditorialDraftGatewayDependencies,
    generateDraftFn: GenerateDraftFunction = legacyGenerateDraft as GenerateDraftFunction,
  ) {
    this.generateDraft = generateDraftFn;
  }

  /**
   * The editorial pass and the composition of its result into a publishable
   * body: editor credit and topic hashtags, then Telegram's own message
   * validation -- the same finishing legacy applies to the baseline, applied
   * once and only to the version that ships.
   *
   * Returns the baseline untouched whenever the pass is off, unavailable, or
   * did not produce something publishable. Adding detail must never be a way
   * for an article to stop existing.
   */
  private async runEditorialPass(request: {
    state: "off" | "collect" | "enabled";
    article: { title?: string | null; canonical_url?: string | null };
    baseline: EnrichedArticle;
    evidence: readonly EditorialEvidence[];
    languageCode: string;
    editor: unknown;
    tagging: { state: string } & Record<string, unknown>;
    unverified: boolean;
  }): Promise<EditorialPassResult> {
    const baselineOnly = (
      status: string,
      diagnostic: string | null = null,
    ): EditorialPassResult => ({
      draft: null,
      body: null,
      summary: {
        state: request.state,
        status,
        selected_version: "baseline",
        diagnostic,
        evidence_map: [],
        implementation: "typed-editorial-pass-v1",
      },
    });

    if (request.state === "off") return baselineOnly("disabled");
    if (!this.dependencies.enrichment) {
      return baselineOnly("fallback_to_baseline", "pass_not_configured");
    }
    // An unverified story keeps legacy's baseline, prefix and caveat intact.
    // Reproducing the UNVERIFIED TREND headline handling here would duplicate
    // a rule that exists to keep a rumour marked, and duplicated safety rules
    // drift. The pass is an improvement; skipping it costs nothing.
    if (request.unverified) {
      return baselineOnly("fallback_to_baseline", "unverified_story");
    }

    const outcome = await this.dependencies.enrichment.enrich({
      article: request.article,
      baselineDraft: request.baseline,
      evidence: request.evidence,
      languageCode: request.languageCode,
      generator: this.dependencies.aiProvider as never,
    });

    if (outcome.status !== "completed") {
      return baselineOnly("fallback_to_baseline", outcome.diagnostic);
    }

    let body: string;
    try {
      const credited = appendEditorCredit(
        outcome.draft.telegramText,
        request.editor,
        request.languageCode,
      ) as string;
      body = appendTopicHashtags(credited, [], request.tagging, {
        languageCode: request.languageCode,
      }) as string;
      validateMessage(body);
    } catch (error) {
      return baselineOnly(
        "fallback_to_baseline",
        `unpublishable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return {
      draft: outcome.draft,
      body,
      summary: {
        state: request.state,
        status: "completed",
        selected_version: "enriched",
        diagnostic: null,
        reader_angle: outcome.readerAngle,
        evidence_map: outcome.evidenceMap,
        similarity: outcome.similarity,
        attempts: outcome.attempts,
        provider: outcome.provider,
        model: outcome.model,
        implementation: "typed-editorial-pass-v1",
      },
    };
  }

  async generate(
    input: GenerateReviewDraftInput,
    signal?: AbortSignal,
  ): Promise<EditorialDraftGenerationResult> {
    const effectiveNewsSettings = buildEffectiveNewsSettings(
      input.settingsSnapshot,
      input.channelId,
      input.languageCode,
    );
    const featureFlags = await resolveFeatureFlags(
      effectiveNewsSettings.channelId,
      input.featureFlags,
      this.dependencies.repository,
    );
    const articleTagging = await resolveArticleTagging(
      effectiveNewsSettings,
      this.dependencies.repository,
      featureFlags,
    );
    const editorialEnrichment = resolveEditorialEnrichment(
      featureFlags,
      effectiveNewsSettings,
    );

    const usageEvents: RecordAiUsageInput[] = [];
    const generationRepository = buildGenerationRepositoryFacade(
      this.dependencies.repository,
      usageEvents,
    );

    // Corroborate before drafting, because src/draft.js derives the unverified
    // caveat from the EVIDENCE (draft.js:296), not from the prose. By the time
    // the draft is being written the decision has already been taken, so this
    // is the only point at which it can be affected without editing frozen
    // legacy code.
    //
    // Every failure here falls back to the original evidence. Adding detail
    // must never become a way for an article to stop being produced.
    let corroboratedEvidence = input.evidence;
    let corroborationAddedSources = false;
    if (this.dependencies.factPlan && this.dependencies.corroboration) {
      try {
        const requests = await this.dependencies.factPlan.plan({
          article: input.article as { title?: string; summary?: string | null },
          // No `as never` on the evidence, in either call.
          //
          // Those casts are how `evidenceText` survived review: they silenced
          // the one check that would have said corroboration was producing a
          // shape the editorial pipeline does not consume. A cast at a seam is
          // a decision to stop checking the seam.
          evidence: input.evidence,
          languageCode: input.languageCode,
          generator: this.dependencies.aiProvider as never,
        });
        if (requests.length) {
          const outcome = await this.dependencies.corroboration.corroborate({
            evidence: input.evidence,
            requests,
            languageCode: input.languageCode,
            search: factSearchCorroborationPort(
              this.dependencies.aiProvider as never,
            ),
          });
          // Always take the outcome's evidence now.
          //
          // The service no longer clears `unverified_community` unless the
          // threshold was met, so this can no longer strip a caveat that was
          // not earned -- the reason this was restricted to `corroborated`
          // before. What it does take, on every article, are the extra sources
          // the searches found, which is the point of searching every article
          // rather than only the doubtful ones.
          if (outcome.status !== "not_needed") {
            corroborationAddedSources =
              outcome.evidence.length > input.evidence.length;
            corroboratedEvidence = [...outcome.evidence];
          }
        }
      } catch {
        corroboratedEvidence = input.evidence;
      }
    }

    const generated = await this.generateDraft(
      {
        aiProvider: this.dependencies.aiProvider,
        client: this.dependencies.client,
        model: this.dependencies.model,
        repository: generationRepository,
        article: input.article,
        evidence: corroboratedEvidence,
        // Opted in HERE, and only when this gateway actually added sources.
        //
        // draft.js:293 refuses a draft when `!allowUnverified && hasNonPrimary`,
        // and every corroborating source arrives as `web_source`. Without this
        // a primary-source article that we deliberately corroborated becomes
        // undraftable -- the run fails with "Draft generation requires
        // primary-source evidence", which is exactly what happened in
        // integration and what the end-to-end check now reproduces.
        //
        // The caveat does NOT come back. draft.js only sets `unverified` for
        // `unverified_community`, and a primary article gaining web sources
        // computes to `web_source`. What changes is the system prompt it picks,
        // which is the honest outcome: the story now rests on more than one
        // kind of source.
        allowUnverified: corroborationAddedSources || input.allowUnverified,
        lease: input.lease,
        languageCode: input.languageCode,
        newsSettings: effectiveNewsSettings,
        editor: this.dependencies.editor,
        articleTagging,
        // Legacy's own editorial pass is switched off here, always.
        //
        // Not because it is bad, but because its structure validation demands
        // the model reproduce source text verbatim (editorial-enrichment.js:237
        // and :249) and `draft.js` swallows the throw, so a straight quote
        // where the source had a typographic one discarded the entire pass as
        // `enrichment_failed`. The owner's decision is that the model should
        // write its own article from the retrieved details rather than copy
        // them, so the pass moved here, where that requirement is gone and
        // grounding is still enforced by the same validator.
        editorialEnrichment: { state: "off" as const },
      },
      signal,
    );

    // The editorial pass, ours, on the baseline legacy just produced.
    //
    // It runs HERE and not inside `generateDraft` because the repository facade
    // above intercepts `createReviewDraft` and persists nothing -- legacy
    // composes the draft, this gateway is what returns it to be saved. So the
    // final article can still be changed at this point, which is what makes a
    // typed editorial pass possible without porting draft.js.
    const enrichment = await this.runEditorialPass({
      state: editorialEnrichment.state,
      article: input.article as { title?: string | null; canonical_url?: string | null },
      baseline: generated.baselineDraft as EnrichedArticle,
      evidence: corroboratedEvidence,
      languageCode: input.languageCode,
      editor: this.dependencies.editor,
      tagging: articleTagging,
      unverified: isUnverified(input.evidence),
    });

    const output = {
      baselineDraft: generated.baselineDraft,
      enrichedDraft: enrichment.draft ?? null,
      editorialEnrichment: enrichment.summary,
      selectedModel: generated.model,
      selectedProvider: generated.provider,
    };

    return {
      draft: {
        article_id: generated.saved.article_id,
        body: enrichment.body ?? generated.saved.body,
        model: generated.saved.model,
        prompt_version: enrichment.draft
          ? `${generated.saved.prompt_version}+typed-editorial-pass-v1`
          : generated.saved.prompt_version,
        reviewer_notes: withEnrichmentNotes(
          generated.saved.reviewer_notes,
          enrichment,
        ),
        lease_name: generated.saved.lease_name ?? input.lease?.name ?? null,
        lease_owner_id: generated.saved.lease_owner_id ?? input.lease?.ownerId ?? null,
        // Omitted, not null, when tagging is off -- exactly what src/draft.js
        // does (`...(state !== "off" ? { topic_assignments } : {})`).
        //
        // This gateway translated that omission into an explicit null, and null
        // is not undefined: the repository's `withTopics` test admitted it,
        // stringified it to the JSON literal `null`, and
        // create_review_draft_with_topics refused it. Every review draft failed
        // whenever tagging was off, which is the default, while legacy running
        // the same repository was fine.
        //
        // The repositories never differed. This call site did.
        ...(generated.saved.topic_assignments != null
          ? { topic_assignments: generated.saved.topic_assignments }
          : articleTagging.state === "off"
            ? {}
            : { topic_assignments: [] }),
        topic_assignment_source:
          generated.saved.topic_assignment_source ?? null,
        topic_assigned_model:
          generated.saved.topic_assigned_model ??
          (articleTagging.state === "off" ? null : generated.model),
      },
      usageEvents,
      output: output as EditorialDraftGenerationResult["output"],
    };
  }
}
