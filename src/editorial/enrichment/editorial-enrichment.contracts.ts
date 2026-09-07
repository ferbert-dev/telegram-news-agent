import type { EditorialEvidence } from "../editorial-application.contracts.js";

/**
 * How long the enriched article may be, in words and sentences.
 *
 * A parameter rather than a constant because the answer is editorial, not
 * technical. The legacy module hard-codes 90-140 words and six sentences in
 * one place and repeats them inside a prompt in another, so changing the
 * length of an article meant editing a frozen file in two places and hoping
 * they agreed.
 */
export type EnrichmentLimits = {
  minWords: number;
  maxWords: number;
  maxSentences: number;
  /**
   * How many source links the published article carries.
   *
   * One, by the repository owner's decision, and the reasoning is worth
   * recording because it is not obvious: the corroborating publishers are
   * themselves newsrooms that took the story from somewhere else, so a list of
   * four links is not four independent authorities -- it is an invitation to
   * go and read the article elsewhere. What they are worth is their DETAIL.
   *
   * So they stay in the evidence the model writes from and are attributed by
   * name in the prose, and the reader gets one link: the article this run
   * actually went to. The per-claim attribution is unchanged and still
   * recorded in reviewer_notes, so the audit trail keeps every source even
   * though the published text shows one.
   */
  maxPublishedSources: number;
};

export const DEFAULT_ENRICHMENT_LIMITS: EnrichmentLimits = {
  // The floor is a guard against a stub, not the way to get length -- a high
  // one is self-defeating, because a refused enrichment falls back to the
  // baseline, which is SHORTER than anything it would have rejected. Length
  // comes from the prompt's aim, which sits midway between these two.
  minWords: 130,
  maxWords: 240,
  maxSentences: 12,
  maxPublishedSources: 1,
};

/** One claim in the article, and the supplied source that supports it. */
export type EnrichmentEvidenceMapEntry = {
  claim: string;
  sourceUrl: string;
  /**
   * The model's own account of what in the source supports the claim.
   *
   * Free text, deliberately. The legacy module required this to appear as an
   * exact substring of the source, and enforced it with `String.includes`
   * after normalising only unicode form and whitespace -- so a straight quote
   * where the source had a typographic one, or an en dash for an em dash,
   * threw and discarded the entire enrichment. It also, by construction,
   * required the model to copy rather than write.
   *
   * That requirement is gone at the repository owner's explicit direction: the
   * point of retrieving details is that the model writes an article from them,
   * not that it reproduces them. The control that remains is the one that
   * actually prevents invention -- `validateGroundedDraft` refuses any claim
   * whose source URL was not supplied as evidence for this article.
   */
  evidenceExcerpt: string;
};

export type EnrichedArticle = {
  headline: string;
  telegramText: string;
  claims: Array<{ text: string; sourceUrl: string }>;
  sourceUrls: string[];
  caveat: string;
};

export type EditorialEnrichmentOutcome =
  | {
      status: "completed";
      draft: EnrichedArticle;
      readerAngle: string;
      evidenceMap: EnrichmentEvidenceMapEntry[];
      similarity: { metric: string; score: number; threshold: number };
      provider: string | null;
      model: string | null;
      attempts: number;
    }
  | {
      /**
       * The baseline stands. Carries the reason, because "it fell back" is the
       * observation that hides the finding -- four consecutive runs on the
       * integration stage reported exactly that and nothing more.
       */
      status: "failed";
      diagnostic: string;
      attempts: number;
    };

export type EnrichmentGenerationPort = {
  generateStructured(input: {
    systemInstruction: string;
    input: unknown;
    zodSchema: unknown;
    jsonSchema: unknown;
    schemaName: string;
    usageOperation: string;
  }): Promise<{
    value?: unknown;
    provider?: string | null;
    model?: string | null;
    usageEvents?: unknown[];
  }>;
};

export type EditorialEnrichmentRequest = {
  article: { title?: string | null; canonical_url?: string | null };
  /** The one link the article publishes: the source this run went to. */
  primarySourceUrl: string;
  baselineDraft: EnrichedArticle;
  evidence: readonly EditorialEvidence[];
  languageCode: string;
  generator: EnrichmentGenerationPort;
};

/**
 * The two legacy functions this pass reuses, as injected ports.
 *
 * They are not imported here. `npm run test:architecture` forbids an
 * application-layer file from reaching into the legacy runtime, and it is
 * right to: the sanctioned place for that seam is `legacy-*.gateway.ts`. So
 * the gateway supplies them and this stays a pure service.
 *
 * Reusing rather than reimplementing is deliberate for the first one in
 * particular. `validateGroundedDraft` is the control that refuses a claim
 * whose source URL was never supplied, and a second copy of that rule is a
 * second copy that can drift away from the one production depends on.
 */
export type GroundedDraftValidator = (
  draft: unknown,
  evidence: readonly unknown[],
  options: {
    languageCode: string;
    minWords: number;
    maxWords: number;
    maxSentences: number;
  },
) => EnrichedArticle;

export type SimilarityMeasure = (
  baseline: unknown,
  candidate: unknown,
) => { metric: string; score: number; threshold: number; tooSimilar: boolean };

export type EditorialEnrichmentPorts = {
  validateDraft: GroundedDraftValidator;
  measureSimilarity: SimilarityMeasure;
};
