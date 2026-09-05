export type EvidenceVerificationStatus =
  | "primary_source"
  | "web_source"
  | "web_search_summary"
  | "unverified_community";

export type CorroborationEvidence = {
  sourceUrl: string;
  verificationStatus?: EvidenceVerificationStatus;
  primary?: boolean;
  title?: string;
  evidenceText?: string;
};

/**
 * What the MODEL asks to look up. Mirrors the shape editorial-enrichment.js
 * already uses, because the model formulating its own query -- with the reason
 * and the fact it expects to find -- is the part that makes this useful. A
 * fixed query built from the headline searches for what we already have.
 */
export type FactRequest = {
  query: string;
  reason: string;
  expectedClaim: string;
};

export type CorroborationOutcome =
  | {
      status: "not_needed";
      evidence: readonly CorroborationEvidence[];
      searches: 0;
    }
  | {
      status: "corroborated";
      /** The original set plus the independent sources that confirmed it. */
      evidence: readonly CorroborationEvidence[];
      searches: number;
      publishers: readonly string[];
    }
  | {
      /**
       * Published anyway, marked. The operator chose a short tag over either
       * suppressing the story or carrying the legacy UNVERIFIED TREND block.
       */
      status: "uncorroborated";
      evidence: readonly CorroborationEvidence[];
      searches: number;
      publishers: readonly string[];
      /** Rendered into the post, e.g. "#rumor". */
      tag: string;
      reason: string;
    };

export type FactSearchPort = {
  searchFact: (input: {
    query: string;
    expectedClaim: string;
    languageCode: string;
    signal?: AbortSignal;
  }) => Promise<{
    value?: {
      fact?: {
        claim?: string;
        sourceUrl?: string;
        sourceTitle?: string;
        evidenceText?: string;
      } | null;
    };
    usageEvents?: unknown[];
  }>;
};
