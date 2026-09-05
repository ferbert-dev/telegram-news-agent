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

/** One source a search came back with. Plain data, no provider's envelope. */
export type CorroborationSource = {
  url: string;
  title?: string;
  excerpt?: string;
};

/**
 * The whole dependency on the outside world: one method, plain data in, plain
 * data out.
 *
 * Deliberately NOT the shape of our AI provider's `searchFact`, which wraps its
 * answer in `{ value: { fact: … } }` -- that envelope is an artifact of how
 * this codebase happens to call models today, and building it into the boundary
 * would make every future search provider imitate it. Exa reaches this through
 * a five-line adapter; Brave, Tavily or a plain HTTP endpoint would each need
 * their own five lines and nothing else.
 *
 * It returns a LIST rather than one source, because most search APIs do. That
 * is not only tidiness: a provider that returns two independent publishers for
 * one question corroborates a story in a single search instead of two, which
 * on a metered budget is the difference between three articles a day and six.
 */
export type CorroborationSearchPort = {
  find(
    request: FactRequest,
    context: { languageCode: string; signal?: AbortSignal },
  ): Promise<readonly CorroborationSource[]>;
};
