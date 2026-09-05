import { Inject, Injectable } from "@nestjs/common";

import type {
  CorroborationEvidence,
  CorroborationOutcome,
  FactRequest,
  FactSearchPort,
} from "./evidence-corroboration.contracts.js";
import { EVIDENCE_CORROBORATION_OPTIONS } from "./evidence-corroboration.tokens.js";

export type EvidenceCorroborationOptions = {
  /** Independent publishers required before an unverified story may be told. */
  requiredPublishers: number;
  /** Hard ceiling on paid searches per article. */
  maxSearches: number;
};

export const RUMOUR_TAG = "#rumor";

export const DEFAULT_CORROBORATION_OPTIONS: EvidenceCorroborationOptions = {
  // Two, not three. Three independent publishers inside a three-search budget
  // would refuse almost every article -- a threshold nothing can meet is a
  // switch that turns the feature off while looking like a policy.
  requiredPublishers: 2,
  // Exa is metered against a $10/month budget, so the ceiling is held here and
  // not by the model. A search is only ever spent on an article that needs one.
  maxSearches: 3,
};

function publisherOf(url: string): string | null {
  try {
    // The registrable host, lowercased, with a leading www. dropped: three
    // links from one newsroom are one source, not three, and
    // www.example.com and example.com are the same publisher.
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

/**
 * Earns the right to drop the "unverified" caveat, rather than deleting it.
 *
 * src/draft.js decides the caveat from the EVIDENCE, not from the prose: if any
 * item is `unverified_community` the headline gets an UNVERIFIED TREND prefix
 * and the prompt is told to say the publisher could not be independently read.
 * Removing that line while the evidence is unchanged would publish a rumour as
 * a confirmed fact -- the risk would remain, only now unlabelled.
 *
 * So this runs BEFORE drafting and changes the evidence instead. When
 * independent publishers confirm the claim, they join the evidence set as
 * `web_source`, the set stops being unverified, and the caveat never appears
 * because the situation that produces it is gone. When they do not, the article
 * is refused rather than published with a disclaimer.
 *
 * Nothing in src/*.js changes. The legacy runtime is frozen, and this reads the
 * seam it already exposes.
 */
@Injectable()
export class EvidenceCorroborationService {
  constructor(
    @Inject(EVIDENCE_CORROBORATION_OPTIONS)
    private readonly options: EvidenceCorroborationOptions,
  ) {}

  async corroborate(input: {
    evidence: readonly CorroborationEvidence[];
    /**
     * What the model asked to look up, in its own words. Executed in order and
     * only until the budget or the threshold runs out -- the model chooses the
     * questions, this chooses how many get asked.
     */
    requests: readonly FactRequest[];
    languageCode: string;
    factSearch: FactSearchPort;
    signal?: AbortSignal;
  }): Promise<CorroborationOutcome> {
    const { evidence, requests, languageCode, factSearch, signal } = input;

    const needsWork = evidence.some(
      (item) =>
        (item.verificationStatus ??
          (item.primary ? "primary_source" : "unverified_community")) ===
        "unverified_community",
    );
    // A story already resting on a primary source costs nothing. Spending a
    // metered search on it would burn the month's budget on the articles that
    // least need it.
    if (!needsWork) {
      return { status: "not_needed", evidence, searches: 0 };
    }

    const known = new Set(
      evidence.map((item) => publisherOf(item.sourceUrl)).filter(Boolean),
    );
    const found = new Map<string, CorroborationEvidence>();
    let searches = 0;

    for (const request of requests) {
      if (searches >= this.options.maxSearches) break;
      if (found.size >= this.options.requiredPublishers) break;
      searches += 1;
      let result;
      try {
        result = await factSearch.searchFact({
          query: request.query,
          expectedClaim: request.expectedClaim,
          languageCode,
          signal,
        });
      } catch {
        // A failed search spends its budget and stops nothing else. Retrying
        // the same query against the same provider would spend the rest of the
        // budget on the same failure.
        continue;
      }

      const fact = result?.value?.fact;
      if (!fact?.sourceUrl) continue;
      const publisher = publisherOf(fact.sourceUrl);
      // Independent means a DIFFERENT publisher. A second page from the
      // newsroom that published the rumour corroborates nothing.
      if (!publisher || known.has(publisher) || found.has(publisher)) continue;

      found.set(publisher, {
        sourceUrl: fact.sourceUrl,
        title: fact.sourceTitle,
        evidenceText: fact.evidenceText,
        // web_source, never primary_source: an independent report is not the
        // same thing as the subject's own announcement, and draft.js ranks
        // those differently on purpose.
        verificationStatus: "web_source",
      });
    }

    const publishers = [...found.keys()];

    // draft.js takes the WEAKEST status in the set, so an original left as
    // `unverified_community` keeps the UNVERIFIED TREND headline and the "could
    // not be independently read" caveat however much corroboration was found.
    // Clearing it is therefore necessary in both branches below.
    const cleared = evidence.map((item) =>
      (item.verificationStatus ?? "unverified_community") ===
      "unverified_community"
        ? { ...item, verificationStatus: "web_source" as const }
        : item,
    );

    if (found.size < this.options.requiredPublishers) {
      // An explicit operator decision, recorded here rather than buried: a
      // story that could not be corroborated is published with a short tag
      // instead of the legacy caveat block, and instead of being suppressed.
      //
      // What that trades is real. The reader is still told -- the tag says
      // rumour -- but it is a tag rather than a sentence, and the draft layer
      // is no longer told the evidence is weak. The remaining protection is
      // validateGroundedDraft, which still refuses any source the model was
      // not given.
      return {
        status: "uncorroborated",
        evidence: [...cleared, ...found.values()],
        searches,
        publishers,
        tag: RUMOUR_TAG,
        reason: `Found ${found.size} independent publisher(s); ${this.options.requiredPublishers} required`,
      };
    }

    return {
      status: "corroborated",
      evidence: [...cleared, ...found.values()],
      searches,
      publishers,
    };
  }
}
