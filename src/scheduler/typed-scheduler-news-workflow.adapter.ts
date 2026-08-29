import { buildSearchPlan } from "../news-settings.js";

import type {
  SchedulerNewsWorkflowApplicationPort,
  SchedulerNewsWorkflowInput,
  SchedulerNewsWorkflowResult,
  SchedulerSettingsSnapshot,
} from "./scheduler-application.contracts.js";

/**
 * Narrow slices of the two collaborators, declared structurally so this adapter
 * depends on neither concrete type.
 *
 * The research shape here is `ResearchExecutionGateway.execute(request, signal)`
 * -- the seam both TypedResearchExecutionGateway and
 * LegacyResearchExecutionGateway implement -- not `ResearchService.runResearch`.
 * That is deliberate: the tier loop needs to drive one research attempt per
 * tier and inspect the outcome, which is exactly what the execution gateway
 * exposes; ResearchService only forwards to it.
 */
export type NewsWorkflowResearchPort = {
  execute(
    request: {
      input: {
        query: string;
        keywords?: string[];
        windowHours?: number;
        newsSettings?: Record<string, unknown> | null;
      };
    },
    signal?: AbortSignal,
  ): Promise<{ selected: ResearchSelection }>;
};

export type ResearchSelection = {
  article: { id: string; [key: string]: unknown };
  source: { name: string; is_primary: boolean; [key: string]: unknown };
  canonicalUrl: string;
  title: string;
  publishedAt: string | null;
  /** Both research engines guarantee a non-empty value before selecting;
   *  the fallback branches explicitly skip a candidate without one. */
  evidenceText: string;
  evidenceUrl?: string;
  publisher?: string;
  verificationStatus?: string;
  discoveryUrl?: string | null;
  unverified?: boolean;
  [key: string]: unknown;
};

export type NewsWorkflowEditorialPort = {
  generateReviewDraft(
    input: {
      article: unknown;
      evidence: EditorialEvidenceShape[];
      languageCode: "en" | "uk" | "de";
      channelId?: string | null;
      allowUnverified?: boolean;
      lease?: { name: string; ownerId: string } | null;
      settingsSnapshot?: Record<string, unknown> | null;
    },
    signal?: AbortSignal,
  ): Promise<{ draft: { id: string }; generation: { draft: { body: string } } }>;
};

export type EditorialEvidenceShape = {
  url: string;
  title?: string | null;
  publisher?: string | null;
  publishedAt?: string | null;
  text: string;
  primary: boolean;
  verificationStatus?: string | null;
};

/** Thrown by the research engine when a tier yields nothing. Matched by name
 *  rather than by class so this adapter does not import either research
 *  implementation — both the legacy and typed engines use this name. */
function isNoCandidates(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "NoResearchCandidatesError";
}

/**
 * Ported verbatim from `buildDraftEvidence` in src/pipeline.js. The verification
 * cascade and the second Reddit-discussion evidence item are load-bearing: the
 * draft generator uses `primary` to decide whether a claim may be stated
 * directly, and drops the discussion item when it would duplicate the article
 * URL.
 */
export function buildDraftEvidence(selected: ResearchSelection): EditorialEvidenceShape[] {
  const verificationStatus =
    selected.verificationStatus ??
    (selected.unverified
      ? "unverified_community"
      : selected.source.is_primary
        ? "primary_source"
        : "web_source");
  const evidenceUrl = selected.evidenceUrl ?? selected.canonicalUrl;
  const primaryEvidence: EditorialEvidenceShape = {
    url: evidenceUrl,
    title: selected.title,
    publishedAt: selected.publishedAt,
    text: selected.evidenceText,
    primary: verificationStatus === "primary_source",
    publisher: selected.publisher ?? selected.source.name,
    verificationStatus,
  };
  if (
    !selected.unverified ||
    !selected.discoveryUrl ||
    selected.discoveryUrl === evidenceUrl
  ) {
    return [primaryEvidence];
  }
  return [
    primaryEvidence,
    {
      url: selected.discoveryUrl,
      title: `Reddit discussion: ${selected.title}`,
      publishedAt: selected.publishedAt,
      text: selected.evidenceText,
      primary: false,
      publisher: selected.source.name,
      verificationStatus: "unverified_community",
    },
  ];
}

/**
 * Fills the seam `SchedulerNewsWorkflowInput`'s own doc comment reserves:
 * "A later adapter composes ResearchService and EditorialWorkflowService behind
 * this seam." `checks/architecture/nestjs-boundaries.ts` forbids
 * RunScheduledNewsOnceUseCase from referencing ResearchService directly, so the
 * composition has to live here rather than being inlined into the use case.
 *
 * On the research side it binds to the execution gateway rather than
 * ResearchService (see NewsWorkflowResearchPort above): the tier loop drives
 * one research attempt per tier and inspects each outcome, and ResearchService
 * only forwards to that same gateway.
 *
 * Reproduces the legacy chain (telegram-bot.js runScheduledNews →
 * runTieredNewsSearch → runWorkflow → runPipeline):
 *
 * 1. Walk `buildSearchPlan`'s tiers in order (48h, then 7d), escalating only on
 *    a no-candidates outcome and rethrowing anything else immediately.
 * 2. On a selection, build evidence with the ported `buildDraftEvidence` and
 *    generate a review draft.
 * 3. If every tier is exhausted, report `no_candidates` rather than throwing —
 *    the scheduler port models that as a normal terminal outcome, whereas
 *    legacy signalled it by letting NoResearchCandidatesError escape into
 *    news-scheduler.js's catch.
 *
 * Draft creation is always manual regardless of the channel's approval policy,
 * matching legacy's `approvalPolicy: "manual"` override: the scheduler
 * publishes separately after its own checkpoint, so generating an
 * auto-published draft here would publish before the checkpoint existed.
 */
export class TypedSchedulerNewsWorkflowAdapter
  implements SchedulerNewsWorkflowApplicationPort
{
  constructor(
    private readonly research: NewsWorkflowResearchPort,
    private readonly editorial: NewsWorkflowEditorialPort,
  ) {}

  async run(input: SchedulerNewsWorkflowInput): Promise<SchedulerNewsWorkflowResult> {
    const { settingsSnapshot, lease, signal, assertOwned } = input;
    const tiers = buildSearchPlan(settingsSnapshot as unknown as Record<string, unknown>) as Array<{
      query: string;
      keywords: string[];
      windowHours: number;
    }>;

    for (const tier of tiers) {
      signal?.throwIfAborted();
      // Legacy re-acquired the lease per tier (each tier was a whole
      // runPipeline), so ownership is checked at the top of every tier too.
      await assertOwned?.();
      let selected: ResearchSelection;
      try {
        const research = await this.research.execute(
          {
            input: {
              query: tier.query,
              keywords: tier.keywords,
              windowHours: tier.windowHours,
              newsSettings: settingsSnapshot as unknown as Record<string, unknown>,
            },
          },
          signal,
        );
        selected = research.selected;
      } catch (error) {
        // Only an empty tier escalates. Anything else (provider exhaustion,
        // persistence failure, cancellation) must surface immediately rather
        // than being retried against a wider window.
        if (isNoCandidates(error)) continue;
        throw error;
      }

      signal?.throwIfAborted();
      // The parity-critical one: src/pipeline.js calls heartbeat.assertOwned()
      // here, between research and generation, so a lease lost during a long
      // research pass fails before any generation tokens are spent.
      await assertOwned?.();
      const generated = await this.editorial.generateReviewDraft(
        {
          article: selected.article,
          evidence: buildDraftEvidence(selected),
          allowUnverified: !selected.source.is_primary,
          lease: { name: lease.name, ownerId: lease.ownerId },
          languageCode: settingsSnapshot.languageCode,
          channelId: settingsSnapshot.channelId,
          settingsSnapshot: settingsSnapshot as unknown as Record<string, unknown>,
        },
        signal,
      );

      return {
        status: "review_ready",
        draftId: generated.draft.id,
        preview: generated.generation.draft.body,
        windowHours: tier.windowHours,
      };
    }

    return { status: "no_candidates" };
  }
}

export type { SchedulerSettingsSnapshot };
