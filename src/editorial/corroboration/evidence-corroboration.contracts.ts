import type { EditorialEvidence } from "../editorial-application.contracts.js";
import type { SourceTier } from "./source-policy.js";

export type EvidenceVerificationStatus =
  | "primary_source"
  | "web_source"
  | "web_search_summary"
  | "unverified_community";

/**
 * An alias, deliberately, and not a parallel shape.
 *
 * This module has now shipped the same defect twice. First the appended items
 * carried `sourceUrl` while draft.js:199 builds its allowed set from
 * `item.url`, so every corroborating source was invisible to the grounding
 * validator. That was fixed, a comment was written warning that the name is
 * load-bearing -- and one field further down the same declaration still said
 * `evidenceText` where the pipeline says `text`.
 *
 * The consequence of the second one was quieter and worse. Grounding accepted
 * the source, so nothing failed; but editorial-enrichment.js reads
 * `item.text ?? item.excerpt`, found neither, and threw "Editorial hook
 * evidence is not present in its source" -- surfacing on the stage as
 * `enrichment_failed` with no message, on four consecutive runs. A corroborating
 * source reached the model as a bare URL with no readable content, which is
 * also why an article that had been corroborated looked exactly like one that
 * had not.
 *
 * A comment asking the next person to remember a field name is not a control.
 * The type is: corroboration produces the same evidence the rest of the
 * editorial pipeline consumes, so a divergence is a compile error rather than
 * a silent one.
 */
export type CorroborationEvidence = EditorialEvidence;

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
      usageEvents: readonly unknown[];
    }
  | {
      status: "corroborated";
      /** The original set plus the independent sources that confirmed it. */
      evidence: readonly CorroborationEvidence[];
      searches: number;
      publishers: readonly string[];
      /** Publishers whose agreement counted towards the threshold. */
      strongPublishers: readonly string[];
      usageEvents: readonly unknown[];
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
      strongPublishers: readonly string[];
      usageEvents: readonly unknown[];
      /** Rendered into the post, e.g. "#rumor". */
      tag: string;
      reason: string;
    };

/** One source a search came back with. Plain data, no provider's envelope. */
export type CorroborationSource = {
  url: string;
  title?: string;
  excerpt?: string;
  /**
   * How much this publisher's agreement is worth. Set by the adapter, because
   * only it knows the URL before the service sees it.
   *
   * Absent is treated as `other`: a source of unknown standing contributes
   * detail and does not lift a caveat, which is the safe reading.
   */
  tier?: SourceTier;
};

export type CorroborationSearchResult = {
  sources: readonly CorroborationSource[];
  /**
   * Provider accounting, carried the same way `ArticleContentPort` carries it.
   *
   * A search that spends metered budget and leaves no trace in the ledger is
   * indistinguishable from one that never ran, which is the state content
   * retrieval was in until a live run had to be diagnosed backwards from which
   * calls were missing.
   */
  usageEvents?: readonly unknown[];
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
  ): Promise<CorroborationSearchResult>;
};
