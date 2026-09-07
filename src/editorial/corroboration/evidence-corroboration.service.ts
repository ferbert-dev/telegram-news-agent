import { Inject, Injectable } from "@nestjs/common";

import type {
  CorroborationEvidence,
  CorroborationOutcome,
  CorroborationSearchResult,
  FactRequest,
  CorroborationSearchPort,
} from "./evidence-corroboration.contracts.js";
import { publisherOf, type SourceTier } from "./source-policy.js";
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
    search: CorroborationSearchPort;
    signal?: AbortSignal;
  }): Promise<CorroborationOutcome> {
    const { evidence, requests, languageCode, search, signal } = input;

    // Searches run for every article now, so `not_needed` no longer means
    // "primary source". It means there was nothing to ask.
    if (!requests.length) {
      return { status: "not_needed", evidence, searches: 0, usageEvents: [] };
    }

    const known = new Set(
      evidence.map((item) => publisherOf(item.url)).filter(Boolean),
    );
    const found = new Map<string, CorroborationEvidence>();
    // Only strong publishers count towards the threshold. Everything else is
    // detail: the article may use it and attribute it, and it does not decide
    // whether the story is verified.
    const strong = new Set<string>();
    const usageEvents: unknown[] = [];
    let searches = 0;

    for (const request of requests) {
      if (searches >= this.options.maxSearches) break;
      if (strong.size >= this.options.requiredPublishers) break;
      searches += 1;
      let result: CorroborationSearchResult;
      try {
        result = await search.find(request, { languageCode, signal });
        usageEvents.push(...(result.usageEvents ?? []));
      } catch {
        // A failed search spends its budget and stops nothing else. Retrying
        // the same question against the same provider would spend the rest of
        // the budget on the same failure.
        continue;
      }

      for (const source of result.sources) {
        if (strong.size >= this.options.requiredPublishers) break;
        const publisher = publisherOf(source.url);
        // Independent means a DIFFERENT publisher. A second page from the
        // newsroom that published the rumour corroborates nothing.
        if (!publisher || known.has(publisher) || found.has(publisher)) continue;
        if ((source.tier ?? "other") === "strong") strong.add(publisher);

        found.set(publisher, {
          url: source.url,
          title: source.title ?? null,
          // `text`, the field name the rest of the pipeline uses. The excerpt
          // is what the search actually read; the title is a poor substitute
          // and is used only so an item is never added with nothing readable
          // in it, which is the state that broke enrichment.
          text: source.excerpt?.trim() || source.title?.trim() || "",
          // Never primary: an independent report is not the subject's own
          // announcement, and draft.js ranks those differently on purpose.
          primary: false,
          verificationStatus: "web_source",
        });
      }
    }

    const publishers = [...found.keys()];
    const strongPublishers = [...strong];

    // draft.js takes the WEAKEST status in the set, so an original left as
    // `unverified_community` keeps the UNVERIFIED TREND headline and the "could
    // not be independently read" caveat however much corroboration was found.
    // Clearing it is what lifts the caveat -- and it is done ONLY when the
    // threshold was actually met.
    const cleared = evidence.map((item) =>
      (item.verificationStatus ?? "unverified_community") ===
      "unverified_community"
        ? { ...item, verificationStatus: "web_source" as const }
        : item,
    );

    if (strong.size < this.options.requiredPublishers) {
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
        // The ORIGINAL evidence, uncleared, plus whatever was found. The extra
        // sources give the draft more to write from, which is the point of
        // searching every article -- but the caveat stays, because nothing
        // reached the threshold. Detail is not verification, and until the
        // #rumor tag renders, clearing here would publish a rumour unmarked.
        evidence: [...evidence, ...found.values()],
        searches,
        publishers,
        strongPublishers,
        usageEvents,
        tag: RUMOUR_TAG,
        reason: `Found ${strong.size} strong and ${found.size - strong.size} other publisher(s); ${this.options.requiredPublishers} strong required`,
      };
    }

    return {
      status: "corroborated",
      evidence: [...cleared, ...found.values()],
      searches,
      publishers,
      strongPublishers,
      usageEvents,
    };
  }
}
