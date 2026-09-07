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
  /**
   * How old a corroborating source may be before it is discarded.
   *
   * A published article about a typhoon carried a forecast lifted from a
   * press conference four days earlier -- "residual circulation after 4
   * September may bring heavy rain" -- printed on the 7th as though it were
   * ahead of the reader. The search had found a genuinely relevant document
   * and nothing anywhere asked when it was written.
   *
   * Wider than the research window on purpose: a story published today can be
   * legitimately corroborated by yesterday's reporting, and a threshold tight
   * enough to exclude that would throw away most real corroboration.
   */
  maxSourceAgeHours: number;
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
  maxSourceAgeHours: 72,
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
    /** Injected so the age rule is testable without waiting for time to pass. */
    now?: () => Date;
  }): Promise<CorroborationOutcome> {
    const { evidence, requests, languageCode, search, signal } = input;
    const now = input.now ?? (() => new Date());

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
        // Old enough that its "what happens next" is already in the past.
        if (isStale(source.publishedAt, now(), this.options.maxSourceAgeHours)) continue;
        if ((source.tier ?? "other") === "strong") strong.add(publisher);

        found.set(publisher, {
          url: source.url,
          title: source.title ?? null,
          // `text`, the field name the rest of the pipeline uses. The excerpt
          // is what the search actually read; the title is a poor substitute
          // and is used only so an item is never added with nothing readable
          // in it, which is the state that broke enrichment.
          text: source.excerpt?.trim() || source.title?.trim() || "",
          // Handed to the model as well as used here, so it can see how old a
          // detail is before repeating it as current.
          publishedAt: source.publishedAt ?? null,
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

/**
 * Older than the window, by the source's own account.
 *
 * An undated source is NOT stale. The provider cannot always estimate a date,
 * and it fails most often on primary documents -- filings, press releases --
 * which are the sources most worth keeping. Dropping every undated result
 * would cost more than it saves, and the hole it leaves is real and worth
 * naming: a stale source with no date still gets through.
 */
function isStale(
  publishedAt: string | null | undefined,
  now: Date,
  maxAgeHours: number,
): boolean {
  if (!publishedAt) return false;
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return false;
  return now.getTime() - published > maxAgeHours * 60 * 60 * 1000;
}
