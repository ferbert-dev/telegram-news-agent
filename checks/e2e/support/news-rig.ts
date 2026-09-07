import "reflect-metadata";

import { randomUUID } from "node:crypto";

import { Test } from "@nestjs/testing";
import { Pool } from "pg";

import { DRIZZLE_DB, PG_POOL } from "../../../src/database/database.tokens.js";
import { createDrizzleDatabase } from "../../../src/database/drizzle-client.js";
import {
  SOURCE_ACQUISITION_DNS,
  SOURCE_ACQUISITION_TRANSPORT,
} from "../../../src/research/source-acquisition.tokens.js";
import {
  CURATION_DNS_LOOKUP,
  CURATION_HTTP,
} from "../../../src/research/curation/evidence-curation.tokens.js";
import { TypedResearchExecutionGatewayModule } from "../../../src/research/typed-research-execution.module.js";
import { RESEARCH_EXECUTION_GATEWAY } from "../../../src/research/research-gateway.tokens.js";
import { EditorialApplicationModule } from "../../../src/editorial/editorial-application.module.js";
import { EDITORIAL_WORKFLOW_APPLICATION } from "../../../src/editorial/editorial-application.tokens.js";
import { EDITORIAL_PERSISTENCE } from "../../../src/editorial/editorial-persistence.tokens.js";
import {
  LegacyEditorialDraftGateway,
  LEGACY_EDITORIAL_ENRICHMENT_PORTS,
} from "../../../src/editorial/legacy-editorial-draft.gateway.js";
import { EditorialEnrichmentService } from "../../../src/editorial/enrichment/editorial-enrichment.service.js";
import { DEFAULT_ENRICHMENT_LIMITS } from "../../../src/editorial/enrichment/editorial-enrichment.contracts.js";
import { LegacyEditorialPublicationPolicyGateway } from "../../../src/editorial/legacy-editorial-publication-policy.gateway.js";
import { OperationsApplicationModule } from "../../../src/operations/operations-application.module.js";
import { PIPELINE_LEASE_APPLICATION } from "../../../src/operations/operations-application.tokens.js";
import { PersistenceFacadeModule } from "../../../src/persistence/persistence-facade.module.js";
import { SettingsApplicationModule } from "../../../src/settings/settings-application.module.js";
import { LateBoundPortRegistry } from "../../../src/composition/late-bound-port.js";
import { FactPlanService } from "../../../src/editorial/corroboration/fact-plan.service.js";
import {
  DEFAULT_CORROBORATION_OPTIONS,
  EvidenceCorroborationService,
} from "../../../src/editorial/corroboration/evidence-corroboration.service.js";
import type { ArticleContentPort } from "../../../src/research/content/article-content.contracts.js";
import { getNewsEditor } from "../../../src/editor.js";
import { tierOf } from "../../../src/editorial/corroboration/source-policy.js";
import { LEGACY_PERSISTENCE } from "../../../src/persistence/legacy-persistence.tokens.js";
import { TelegramPersistenceModule } from "../../../src/telegram/telegram-persistence.module.js";
import {
  TELEGRAM_CHECKPOINTS_PERSISTENCE,
  TELEGRAM_NEWS_JOBS_PERSISTENCE,
} from "../../../src/telegram/telegram-persistence.tokens.js";
import { TelegramUpdatesRepository } from "../../../src/telegram/telegram-updates-repository.js";
import { RunTelegramNewsUseCase } from "../../../src/telegram/application/run-telegram-news.use-case.js";
import { TelegramNewsJobWorker } from "../../../src/telegram/telegram-news-job-worker.js";
import { TypedNewsJobWorkflowAdapter } from "../../../src/telegram/typed-news-job-workflow.adapter.js";
import { TypedNewsJobDeliveryAdapter } from "../../../src/telegram/typed-news-job-delivery.adapter.js";
import type { TelegramControlRequest } from "../../../src/telegram/telegram-application.contracts.js";

/**
 * The `/news` rig: real PostgreSQL, the real module graph, and exactly three
 * fakes — the HTTP transport that fetches feeds, the AI provider, and the
 * Telegram send. Those are the three things that cost money or reach the
 * network. Everything else runs.
 *
 * This started as one happy-path test and is now a rig because the happy path
 * was not where the failures were. Four consecutive integration runs failed on
 * paths the single test could not reach: a content provider over its quota, a
 * search that threw, a feed that answered 500. Each one was found by a person
 * typing `/news` at a live bot. A rig that can only prove the good day proves
 * the least interesting thing about the system.
 *
 * Every scenario gets its own feed host, so fixtures never collide and a
 * scenario cannot be made to pass by state another one left behind.
 */

export const RIG_ENABLED = process.env.RUN_DATABASE_INTEGRATION === "1";
export const RIG_CONNECTION =
  process.env.DATABASE_TEST_URL ?? process.env.DATABASE_URL;

/** A minimal, valid RSS feed. Two items, both recent, both plausible news. */
export function feedXml(now: Date, host: string): string {
  const pubDate = new Date(now.getTime() - 60 * 60 * 1000).toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Example Research Wire</title>
  <link>https://${host}/</link>
  <item>
    <title>Observatory confirms a new measurement of the Hubble constant</title>
    <link>https://${host}/hubble-measurement</link>
    <pubDate>${pubDate}</pubDate>
    <description>Researchers published a peer-reviewed measurement narrowing the uncertainty on the expansion rate.</description>
  </item>
  <item>
    <title>Laboratory reports a reproducible superconductivity result</title>
    <link>https://${host}/superconductivity</link>
    <pubDate>${pubDate}</pubDate>
    <description>An independent group reproduced the result at ambient pressure under review conditions.</description>
  </item>
</channel></rss>`;
}

export type AiAnswer = (
  request: Record<string, unknown>,
  schema: string,
) => unknown | undefined;

/**
 * Answers every structured-generation request with something schema-valid.
 *
 * Keyed on the schema name rather than returning one shape for everything: the
 * pipeline asks for different things at each stage, and a fake that ignored
 * that would pass while proving nothing about the stages it skipped.
 */
function fakeAiProvider(
  counters: Record<string, number>,
  factSearches: string[],
  draftEvidence: string[][],
  draftEvidenceText: number[][],
  override?: AiAnswer,
  shortFirstEnrichment = false,
) {
  let enrichmentCalls = 0;
  const fallback = (request: Record<string, unknown>, schema: string): unknown => {
    // Substring, not equality: the policy runs twice under two schema names --
    // "excluded_topic_classification" during research and
    // "final_publication_excluded_topic_classification" immediately before the
    // send. An exact match answered only the first, and the second fell through
    // to an unrecognised response, which the policy correctly treats as
    // uncertain and blocks. That fail-closed behaviour is right; the fake was
    // what was wrong.
    if (schema.includes("excluded_topic_classification")) {
      const topics =
        (request.input as { excludedTopics?: Array<{ code: string }> })
          ?.excludedTopics ?? [];
      return {
        assessments: topics.map(({ code }) => ({
          topicCode: code,
          relation: "unrelated",
        })),
      };
    }
    if (schema.includes("feed_candidate") || schema.includes("curation")) {
      return {
        selections: [
          { index: 0, reason: "Most significant verified result in the window." },
        ],
      };
    }
    // searchFact carries no schemaName, so it is recognised by its own fields.
    // Without this the fake returned {}, corroboration found nothing, no source
    // was ever appended, and the assertions could not fail however broken the
    // appending was -- which is exactly what a mutation showed.
    if (request.expectedClaim && request.query) {
      factSearches.push(String(request.query));
      return {
        fact: {
          claim: String(request.expectedClaim),
          sourceUrl: `https://corroborator-${factSearches.length}.example/story`,
          sourceTitle: "Independent report",
          sourceKind: "reputable_news",
          evidenceText: "A second newsroom reported the same result.",
        },
      };
    }
    if (schema.includes("fact_plan")) {
      return {
        requests: [
          {
            query: "independent confirmation of the reported result",
            reason: "a second newsroom would have to have reported it",
            expectedClaim: "The result was reported independently.",
          },
          {
            query: "second independent account of the result",
            reason: "two publishers are required to clear the story",
            expectedClaim: "A second publisher reported it.",
          },
        ],
      };
    }
    if (schema.includes("editorial_enrichment")) {
      // An enrichment that PARAPHRASES its evidence instead of quoting it.
      //
      // That is the point of the scenario. The legacy pass required
      // `evidenceExcerpt` to appear as an exact substring of the source and
      // threw when it did not, so this fixture would have failed there -- and
      // did, when it was written that way: the paraphrase mutation reproduced
      // the stage's `enrichment_failed` exactly. The requirement is gone at the
      // owner's direction, because retrieving details is worth nothing if the
      // model is then forbidden to write from them.
      //
      // What must still hold is grounding: every claim cites a URL that was
      // actually supplied. A separate scenario proves an invented URL is still
      // refused.
      const input = request.input as {
        evidence?: Array<{ url?: string; text?: string }>;
      };
      const url = String(input.evidence?.[0]?.url ?? "");
      const headline = "Independent accounts converge on one measurement";
      const claim = "the reported uncertainty band narrowed";
      // The template, written out: four paragraphs, each with its one job,
      // and a URL glued into the prose the way the model actually did it.
      //
      // The stray link is deliberate. A published post carried three -- the
      // primary buried mid-sentence as "Джерело: https://..." and a formal
      // block listing the two corroborating outlets. The pipeline has to strip
      // that and publish one link, so the fixture has to produce it.
      enrichmentCalls += 1;
      const strayLink = "https://www.dw.com/en/some-other-report";
      const paragraphs = [
        // 1. hook, then what happened
        "A second newsroom has now described the same result, and the two accounts agree on the part that matters most to an ordinary reader. "
          + `Taken together they show that ${claim}, which is the whole of what the supplied reporting will currently support. `
          + "That leaves fewer competing explanations standing than there were a year ago.",
        // 2. the detail, with the stray link the pipeline must remove
        "The narrowed range is the concrete change here: where the earlier figure left room for three competing accounts of how the measurement came about, it now leaves room for one. "
          + "The revision is small in absolute terms and large in what it rules out, which is why the groups involved described it as the most useful result of the year. "
          + `Джерело: ${strayLink}`,
        // 3. why it matters
        "Anyone who has been relying on the older figure should expect to see it revised over the coming months, in textbooks as well as in ordinary press coverage. "
          + "The practical effect is small today and larger later, once the revised number reaches the reference material that everyone else quotes without checking.",
        // 4. what is unknown
        "The underlying analysis has not yet been reproduced by a group with no involvement in either effort, and neither account says when that work might be finished, so none of this is settled.",
      ].join("\n\n");
      // Deliberately under the floor on the first call, so the scenario fails
      // unless the pass asks again with its own word count as feedback.
      const bodyText =
        shortFirstEnrichment && enrichmentCalls === 1
          ? paragraphs.split("\n\n")[0] ?? ""
          : paragraphs;
      return {
        readerAngle: "What the narrowed figure changes for a general reader.",
        draft: {
          headline,
          telegramText: `${headline}\n\n${bodyText}\n\nSources:\n${url}`,
          claims: [
            { text: headline, sourceUrl: url },
            { text: claim, sourceUrl: url },
          ],
          sourceUrls: [url],
          caveat: "The work still awaits independent replication.",
        },
        // Worded differently from draft.claims on purpose.
        //
        // The first version of the map check required these to match the claim
        // text byte-for-byte, and the stage rejected a real enrichment with
        // `evidence_map_does_not_match_claims` within minutes of the provider
        // timeout being fixed. A model does not repeat its own sentence
        // identically in two fields, and asking it to was the same demand this
        // module exists to remove.
        evidenceMap: [
          {
            claim: `${headline} — as the article states it`,
            sourceUrl: url,
            // Deliberately not a quotation. This is the model's own account of
            // what supports the claim, which is exactly what the removed check
            // would have rejected.
            evidenceExcerpt: "The source reports the same convergence in its own words.",
          },
          {
            claim: `${claim}, in the reporting's own framing`,
            sourceUrl: url,
            evidenceExcerpt: "The source gives the narrowed range for the measurement.",
          },
        ],
      };
    }
    if (schema.includes("draft") || schema.includes("Draft")) {
      // Built FROM the request, not from a constant.
      //
      // The grounding validator requires every claim to cite a URL that was
      // actually supplied as evidence for THIS article. A fixed fixture only
      // validates when the pipeline happens to select the article it was
      // written for -- and which of the feed's items wins depends on ranking
      // and on what deduplication has seen before, so a constant made this
      // fail as soon as the rig had state from a previous run.
      const requestInput = request.input as {
        article?: { title?: string; url?: string };
        evidence?: Array<{ url?: string; text?: string }>;
      };
      const url = requestInput.evidence?.[0]?.url ?? requestInput.article?.url ?? "";
      // Cite the LAST evidence item too -- the one corroboration appended.
      //
      // This is the assertion that would have caught the original defect. The
      // module was written against a field named `sourceUrl` while draft.js
      // builds its allowed set from `item.url` (draft.js:199), so every
      // appended source was invisible to the grounding validator.
      const evidenceItems = requestInput.evidence ?? [];
      // Recorded, because the difference between "one search failed" and "the
      // whole corroboration block was abandoned" is invisible from the outside
      // and is worth real money: the gateway's outer catch throws away every
      // source the earlier searches already paid for.
      draftEvidence.push(evidenceItems.map((item) => String(item?.url ?? "")));
      draftEvidenceText.push(
        evidenceItems.map((item) => String(item?.text ?? "").length),
      );
      const corroboratedUrl =
        evidenceItems.length > 1
          ? evidenceItems[evidenceItems.length - 1]?.url
          : undefined;
      const headline = String(requestInput.article?.title ?? "Untitled");
      const claim =
        "An independent group reported the result under review conditions.";
      return {
        headline,
        telegramText: [
          headline,
          "",
          claim,
          "",
          "Why it matters: it narrows which explanations remain viable.",
          "",
          "Caveat: the result awaits independent replication.",
          "",
          "Source:",
          url,
        ].join("\n"),
        claims: [
          { text: headline, sourceUrl: url },
          { text: claim, sourceUrl: url },
          ...(corroboratedUrl
            ? [
                {
                  text: "A second publisher reported the same result.",
                  sourceUrl: corroboratedUrl,
                },
              ]
            : []),
        ],
        sourceUrls: corroboratedUrl ? [url, corroboratedUrl] : [url],
        caveat: "The result awaits independent replication.",
        topicTags: [],
      };
    }
    return {};
  };

  const answer = (request: Record<string, unknown>): unknown => {
    const schema = String(request.schemaName ?? "");
    counters[schema] = (counters[schema] ?? 0) + 1;
    // The override sees every request first and may throw, which is how a
    // scenario simulates a provider that is down or over quota. Returning
    // undefined means "not my business", and the default answer stands.
    const injected = override?.(request, schema);
    return injected === undefined ? fallback(request, schema) : injected;
  };

  const call = async (request: Record<string, unknown>) => ({
    value: answer(request),
    usageEvents: [],
    provider: "fake",
    model: "fake-model",
  });

  return {
    names: ["fake"],
    generateStructured: call,
    generateStructuredOnce: call,
    searchNews: call,
    searchFeeds: call,
    searchFact: call,
    async testConnection() {
      return { value: {}, usageEvents: [] };
    },
    async testExaConnection() {
      return { value: {}, usageEvents: [] };
    },
  };
}

export type NewsRigOptions = {
  /**
   * The feed's host, unique per scenario. Fixtures are torn down by this
   * prefix, so two scenarios sharing a host would delete each other's rows and
   * a re-run would start from state the previous scenario left.
   */
  host: string;
  /** Sees every AI request; returning undefined keeps the default answer. */
  ai?: AiAnswer;
  /**
   * `null` removes the content port entirely — the pre-Exa configuration.
   * Omitted, a working fake stands in for `getContents`.
   */
  articleContent?: ArticleContentPort | null;
  /**
   * URLs the corroboration search returns, per search, in order.
   *
   * Default: one strong publisher per search, which is what a working Exa
   * looks like. A scenario that wants unvetted publishers names them.
   */
  searchResults?: Array<string[] | "throws">;
  /**
   * Makes the first editorial attempt come back under the word floor.
   *
   * A floor on its own makes articles shorter, not longer: a refused
   * enrichment falls back to the baseline, which is shorter than anything the
   * floor would have rejected. The corrective retry is what makes a floor
   * usable, so it needs a scenario that can only pass if the retry happens.
   */
  shortFirstEnrichment?: boolean;
  /** Answers the feed fetch. Default: 200 with valid RSS. */
  feedResponse?: (xml: string) => Response;
  /**
   * The article body the HTML extractor finds, or null to make it fail the way
   * an unreachable page does.
   *
   * The rig used to leave this path on the real network: `fetchArticle` went
   * through the un-overridden curation transport, every fallback made a real
   * outbound request, and the scenario that depended on it silently tested a
   * DNS failure rather than an extractor. "Costs nothing and needs nothing"
   * was not true of the fallback path until this existed.
   */
  extractedHtml?: string | null;
  /**
   * Feature flags to switch on for this channel before the run.
   *
   * Editorial enrichment is `enabled` on the integration stage and has failed
   * on every run there, and until this existed the rig could not reach it at
   * all: the flag defaults to off, so the whole enrichment path -- the one
   * that produces the longer, source-mapped article -- was unexercised while
   * being the thing that kept breaking.
   */
  featureFlags?: Record<string, "off" | "collect" | "enabled">;
  /** The Telegram send, the one thing between this rig and a real post. */
  publish?: (
    request: Record<string, unknown>,
  ) => Promise<{ messageId: number; messageDate: number }>;
};

export type NewsRig = {
  pool: Pool;
  channelId: string;
  updateId: number;
  host: string;
  /** Every AI schema name asked for, and how often. */
  schemaCounters: Record<string, number>;
  /** Queries the corroboration searches actually ran. */
  factSearches: string[];
  /** The evidence URLs handed to each draft request, in order. */
  draftEvidence: string[][];
  /**
   * How many characters of `text` each of those items carried.
   *
   * A zero here is the defect that cost four runs: an appended source whose
   * text sat under a field name nothing reads arrives at the model, and at
   * editorial enrichment, as a bare URL.
   */
  draftEvidenceText: number[][];
  /** URLs the content port was asked to load. */
  contentFetches: string[];
  /** What reached the channel. Empty is the safe state, not the broken one. */
  published: Array<Record<string, unknown>>;
  /** Review cards handed to the reviewer. */
  deliveries: Array<Record<string, unknown>>;
  sentToTelegram: Array<{ method: string; payload: Record<string, unknown> }>;
  /** Real errors, before the worker classifies them into an error_code. */
  workflowErrors: string[];
  /** What the worker actually wrote to its error log. */
  workerLog: string[];
  researchErrors: string[];
  feedRequests: () => number;
  /** How often the HTML extractor was asked for a page. */
  extractorRequests: () => number;
  enqueue: (updateId?: number) => Promise<{ status: string }>;
  runWorkerOnce: () => Promise<string>;
  jobRow: (updateId?: number) => Promise<Record<string, unknown> | undefined>;
  checkpoint: (updateId?: number) => Promise<Record<string, unknown> | undefined>;
  editorial: {
    publishApprovedDraft: (input: {
      draftId: string;
      channelId: string;
      publicationPath: string;
    }) => Promise<{ status: string } & Record<string, unknown>>;
  };
  editorialPersistence: { approveDraft: (draftId: string) => Promise<unknown> };
  /** A diagnostic dump, attached to failures so a red run says why. */
  diagnosis: () => string;
};

/**
 * Builds the rig, runs `body`, and tears the fixtures down whatever happens.
 *
 * Teardown is not best-effort: it runs in one transaction and a failure is
 * raised, because a rig that half-cleans leaves the NEXT scenario failing for a
 * reason that has nothing to do with the code under test. That happened, and it
 * cost an afternoon.
 */
export async function withNewsRig(
  options: NewsRigOptions,
  body: (rig: NewsRig) => Promise<void>,
): Promise<void> {
  const pool = new Pool({ connectionString: RIG_CONNECTION, max: 8 });
  const drizzle = createDrizzleDatabase(pool);
  const channelId = `@e2e-${randomUUID()}`;
  const firstUpdateId = 2_100_000_000 + Math.floor(Math.random() * 50_000_000);
  // Checkpoints are keyed by update_id and cascade from telegram_updates, so
  // teardown has to know which updates this scenario claimed. Deleting by
  // channel would not reach them: the checkpoint table carries no channel.
  const claimedUpdateIds = new Set<number>();
  const now = new Date();
  const { host } = options;

  const contentFetches: string[] = [];
  const defaultContent: ArticleContentPort = {
    async fetch(url: string) {
      contentFetches.push(url);
      // Long enough to clear the port's own minimum AND the gateway's
      // thin-article threshold, because the shape being modelled is
      // `verbosity: "full"` -- a whole article, not the 1000-character compact
      // summary that made retrieval lose to the free extractor on the stage.
      // A scenario that wants the thin case asks for it explicitly.
      return { url, text: "Retrieved article body. ".repeat(200) };
    },
  };
  const articleContent =
    options.articleContent === undefined ? defaultContent : options.articleContent;

  const factSearches: string[] = [];
  // The corroboration search port, driven directly rather than through the
  // provider cascade -- which is how production now reaches Exa, because the
  // cascade's own searchFact keeps one result per search and only from a
  // fixed host list.
  const searchPages =
    options.searchResults ?? [
      ["https://www.reuters.com/world/first"],
      ["https://apnews.com/article/second"],
      ["https://www.bbc.co.uk/news/third"],
    ];
  let searchPage = 0;
  const factSearch = {
    async find(request: { query: string }) {
      factSearches.push(request.query);
      const page = searchPages[searchPage++] ?? [];
      // "throws" is how a scenario models Exa being down or over quota. It has
      // to be injected HERE and not through the AI provider: corroboration
      // reaches the typed search port directly now, and two scenarios that
      // injected at the provider went green while testing nothing.
      if (page === "throws") throw new Error("Exa search unavailable");
      const urls = page;
      // Drops a source the policy will not classify, exactly as the real
      // adapter does (`if (!url || !tier) continue`).
      //
      // The first version substituted "other" for an unclassified host, which
      // made this fake MORE permissive than production: a mutation that
      // restored the legacy behaviour of discarding unvetted publishers passed
      // the whole suite, because the fake had already smuggled them through.
      return {
        sources: urls.flatMap((url) => {
          const tier = tierOf(url);
          return tier
            ? [{
                url,
                title: "Independent report",
                excerpt: "A second newsroom reported the same result in its own words.",
                tier,
              }]
            : [];
        }),
        usageEvents: [],
      };
    },
  };
  const draftEvidence: string[][] = [];
  const draftEvidenceText: number[][] = [];
  const schemaCounters: Record<string, number> = {};
  const aiProvider = fakeAiProvider(
    schemaCounters,
    factSearches,
    draftEvidence,
    draftEvidenceText,
    options.ai,
    options.shortFirstEnrichment ?? false,
  );

  let feedRequests = 0;
  const transport = {
    async fetchPinned(_url: URL) {
      feedRequests += 1;
      const xml = feedXml(now, host);
      return (
        options.feedResponse?.(xml) ??
        new Response(xml, {
          status: 200,
          headers: { "content-type": "application/rss+xml" },
        })
      );
    },
  };
  // The HTML extractor's own transport, faked exactly like the feed's. The
  // extractor parses real HTML, so this serves real HTML.
  const extractorBody =
    options.extractedHtml === undefined
      ? `<html><body><article>${"The extracted article body continues. ".repeat(80)}</article></body></html>`
      : options.extractedHtml;
  let extractorRequests = 0;
  const curationHttp = {
    async fetchPinned(_url: URL) {
      extractorRequests += 1;
      if (extractorBody === null) throw new Error("page unreachable");
      return new Response(extractorBody, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  };

  const dns = {
    async lookup() {
      // A routable public address, and deliberately not a documentation range.
      // The gateway's SSRF guard blocks 203.0.113.0/24, 192.0.2.0/24 and
      // 198.51.100.0/24 along with every private range -- so the obvious choice
      // for a fake makes every fetch throw before it reaches the transport,
      // which reads as "research found nothing" rather than as a rejected
      // address. Nothing is dialled: the transport is faked too.
      return [{ address: "93.184.216.34", family: 4 as const }];
    },
  };

  const published: Array<Record<string, unknown>> = [];
  const publicationGateway = {
    async publish(request: Record<string, unknown>) {
      published.push({ channelId: request.channelId, text: request.text });
      return (
        (await options.publish?.(request)) ?? {
          messageId: 9001,
          messageDate: 1_757_000_000,
        }
      );
    },
  };

  const sentToTelegram: Array<{
    method: string;
    payload: Record<string, unknown>;
  }> = [];

  // The draft gateway needs the persistence facade, which only exists once the
  // container is built -- the same circularity the composition root solves,
  // solved the same way, so this rig wires the product the way the product is
  // wired rather than inventing a shortcut.
  const ports = new LateBoundPortRegistry();
  const legacyPersistence = ports.create<object>("legacy-persistence");

  const moduleRef = await Test.createTestingModule({
    imports: [
      SettingsApplicationModule,
      PersistenceFacadeModule,
      TelegramPersistenceModule,
      OperationsApplicationModule.register({
        notionAudit: {
          finish: async () => undefined,
          start: async () => ({}),
        } as never,
      }),
      TypedResearchExecutionGatewayModule.register({
        aiProvider: aiProvider as never,
        ...(articleContent ? { articleContent } : {}),
      }),
      EditorialApplicationModule.register({
        draft: new LegacyEditorialDraftGateway({
          aiProvider: aiProvider as never,
          model: "fake-model",
          repository: legacyPersistence.port as never,
          editor: getNewsEditor({}) as never,
          // The corroboration path, exercised rather than assumed.
          //
          // The old single test stayed green through every change to these two
          // because its module graph never included them, so the new code was
          // never reached. A check that cannot fail for the code it is meant to
          // cover is worse than no check: it reports safety it did not
          // establish.
          factPlan: new FactPlanService(),
          corroboration: new EvidenceCorroborationService(
            DEFAULT_CORROBORATION_OPTIONS,
          ),
          factSearch: factSearch as never,
          enrichment: new EditorialEnrichmentService(
            LEGACY_EDITORIAL_ENRICHMENT_PORTS,
            DEFAULT_ENRICHMENT_LIMITS,
          ),
        }) as never,
        publication: publicationGateway as never,
        excludedTopics: new LegacyEditorialPublicationPolicyGateway({
          aiProvider: aiProvider as never,
        }) as never,
      }),
    ],
    providers: [RunTelegramNewsUseCase],
  })
    .overrideProvider(PG_POOL)
    .useValue(pool)
    .overrideProvider(DRIZZLE_DB)
    .useValue(drizzle)
    .overrideProvider(SOURCE_ACQUISITION_TRANSPORT)
    .useValue(transport)
    .overrideProvider(SOURCE_ACQUISITION_DNS)
    .useValue(dns)
    .overrideProvider(CURATION_HTTP)
    .useValue(curationHttp)
    .overrideProvider(CURATION_DNS_LOOKUP)
    .useValue(async () => [{ address: "93.184.216.34", family: 4 as const }])
    .compile();
  await moduleRef.init();
  legacyPersistence.bind(
    moduleRef.get(LEGACY_PERSISTENCE, { strict: false }) as object,
  );
  ports.assertAllBound();

  try {
    const updates = new TelegramUpdatesRepository(pool, drizzle);
    const jobs = moduleRef.get(TELEGRAM_NEWS_JOBS_PERSISTENCE, { strict: false });
    const checkpoints = moduleRef.get(TELEGRAM_CHECKPOINTS_PERSISTENCE, {
      strict: false,
    });
    const editorial = moduleRef.get(EDITORIAL_WORKFLOW_APPLICATION, {
      strict: false,
    });
    const editorialPersistence = moduleRef.get(EDITORIAL_PERSISTENCE, {
      strict: false,
    });
    const leases = moduleRef.get(PIPELINE_LEASE_APPLICATION, { strict: false });
    const research = moduleRef.get(RESEARCH_EXECUTION_GATEWAY, { strict: false });
    const useCase = moduleRef.get(RunTelegramNewsUseCase);

    await pool.query("select * from public.get_or_create_news_settings($1, $2, $3)", [
      channelId,
      987_654,
      4242,
    ]);
    for (const [featureKey, state] of Object.entries(options.featureFlags ?? {})) {
      await pool.query(
        `insert into public.news_feature_flags (telegram_channel_id, feature_key, state, updated_by)
         values ($1, $2, $3, 4242)
         on conflict (telegram_channel_id, feature_key)
         do update set state = excluded.state, version = public.news_feature_flags.version + 1`,
        [channelId, featureKey, state],
      );
    }
    await pool.query(
      `insert into public.sources (name, homepage_url, feed_url, source_type, reliability_score, enabled, discovered_by)
       values ($1, $2, $3, 'rss', 90, true, 'seed')
       on conflict do nothing`,
      ["Example Research Wire", `https://${host}/`, `https://${host}/rss`],
    );

    // Research reports "no candidates" for a dozen different reasons and the
    // workflow adapter deliberately swallows that distinction. For a rig whose
    // whole job is to find out WHY, the reason has to be captured.
    const researchErrors: string[] = [];
    const wrappedResearch = {
      async execute(input: unknown, signal?: AbortSignal) {
        try {
          return await (
            research as { execute: (i: unknown, s?: AbortSignal) => Promise<unknown> }
          ).execute(input, signal);
        } catch (error) {
          researchErrors.push(describe(error));
          throw error;
        }
      },
    };

    const deliveries: Array<Record<string, unknown>> = [];
    const workflow = new TypedNewsJobWorkflowAdapter({
      research: wrappedResearch as never,
      editorial: editorial as never,
      editorialPersistence: editorialPersistence as never,
      checkpoints: checkpoints as never,
      pipelineLease: leases as never,
      ownerId: randomUUID(),
    });

    // The worker classifies any error into an error_code and moves on, which is
    // right for production and useless here. Capture the real one.
    const workerLog: string[] = [];
    const workflowErrors: string[] = [];
    const originalRun = workflow.run.bind(workflow);
    (workflow as unknown as { run: unknown }).run = async (...args: unknown[]) => {
      try {
        return await (originalRun as (...a: unknown[]) => Promise<unknown>)(...args);
      } catch (error) {
        workflowErrors.push(describe(error));
        throw error;
      }
    };

    const worker = new TelegramNewsJobWorker({
      jobs: jobs as never,
      workflow: workflow as never,
      delivery: new TypedNewsJobDeliveryAdapter({
        checkpoints: checkpoints as never,
        reviewDelivery: {
          async execute(input: Record<string, unknown>) {
            deliveries.push(input);
            return { status: "review_ready" };
          },
        } as never,
        adminMessages: {
          async notify(input: { chatId: number; text: string }) {
            sentToTelegram.push({ method: "sendMessage", payload: input as never });
          },
        },
      }) as never,
      newClaimToken: () => randomUUID(),
      maxExecutionAttempts: 1,
      // Captured, not discarded. A failed job that logs nothing is the state
      // that made a stage failure take a whole session to diagnose.
      log: {
        info() {},
        error(message: string) {
          workerLog.push(message);
        },
      },
    });

    const rig: NewsRig = {
      pool,
      channelId,
      updateId: firstUpdateId,
      host,
      schemaCounters,
      factSearches,
      draftEvidence,
      draftEvidenceText,
      contentFetches,
      published,
      deliveries,
      sentToTelegram,
      workflowErrors,
      workerLog,
      researchErrors,
      feedRequests: () => feedRequests,
      extractorRequests: () => extractorRequests,
      async enqueue(updateId = firstUpdateId) {
        claimedUpdateIds.add(updateId);
        const claim = await updates.claimTelegramUpdate({
          updateId,
          updateKind: "message",
        });
        if (!claim.claim_token) {
          throw new Error(`the update was not claimable: ${JSON.stringify(claim)}`);
        }
        const request: TelegramControlRequest = {
          updateId,
          updateKind: "message",
          channelId,
          actorId: 4242,
          chatId: 987_654,
          chatType: "private",
          route: { kind: "news" },
        };
        return (await useCase.execute(request, claim.claim_token)) as {
          status: string;
        };
      },
      async runWorkerOnce() {
        return (await worker.runOnce()) as unknown as string;
      },
      async jobRow(updateId = firstUpdateId) {
        const { rows } = await pool.query(
          `select status, outcome_status, error_code, draft_id,
                  execution_attempt_count, delivery_attempt_count
             from public.telegram_news_jobs where request_update_id = $1`,
          [updateId],
        );
        return rows[0];
      },
      async checkpoint(updateId = firstUpdateId) {
        return (await checkpoints.getTelegramNewsCheckpoint(updateId)) as
          | Record<string, unknown>
          | undefined;
      },
      editorial: editorial as NewsRig["editorial"],
      editorialPersistence: editorialPersistence as NewsRig["editorialPersistence"],
      diagnosis() {
        return [
          `workflow errors: ${workflowErrors.length ? workflowErrors.join(" | ") : "none"}`,
          `research errors: ${researchErrors.length ? researchErrors.join(" | ") : "none"}`,
          `AI schemas: ${JSON.stringify(schemaCounters)}`,
          `fact searches: ${JSON.stringify(factSearches)}`,
          `draft evidence: ${JSON.stringify(draftEvidence)}`,
          `draft evidence text lengths: ${JSON.stringify(draftEvidenceText)}`,
          `content fetches: ${contentFetches.length}`,
          `feed requests: ${feedRequests}`,
          `extractor requests: ${extractorRequests}`,
        ].join("\n  ");
      },
    };

    await body(rig);
  } finally {
    // Hermetic teardown, and it must actually succeed.
    //
    // Twelve tables reference articles or drafts. An earlier version deleted
    // articles directly and swallowed the failure, so a foreign key from
    // publication_policy_blocks kept them alive -- and the NEXT run found no
    // new articles, failing for a reason that had nothing to do with the code.
    // Deleting dependants first, in one transaction, and letting a failure
    // surface is what makes the rig reusable.
    const like = `https://${host}/%`;
    const fixtureArticles = `select id from public.articles where canonical_url like '${like}'`;
    const fixtureDrafts = `select id from public.drafts where article_id in (${fixtureArticles})`;
    const updateIds = [...claimedUpdateIds, firstUpdateId].join(", ");
    try {
      await pool.query("begin");
      for (const statement of [
        `delete from public.published_posts where article_id in (${fixtureArticles})`,
        `delete from public.publication_policy_blocks where article_id in (${fixtureArticles})`,
        `delete from public.story_publication_claims where article_id in (${fixtureArticles})`,
        `delete from public.telegram_news_request_checkpoints where update_id in (${updateIds})`,
        `delete from public.telegram_review_sessions where draft_id in (${fixtureDrafts})`,
        `delete from public.telegram_news_jobs where telegram_channel_id = '${channelId}'`,
        `delete from public.article_story_decisions where article_id in (${fixtureArticles})`,
        `delete from public.article_topics where article_id in (${fixtureArticles})`,
        `delete from public.ai_usage_events where article_id in (${fixtureArticles})`,
        `delete from public.raw_contents where article_id in (${fixtureArticles})`,
        `delete from public.drafts where article_id in (${fixtureArticles})`,
        `delete from public.articles where canonical_url like '${like}'`,
        `delete from public.sources where feed_url = 'https://${host}/rss'`,
        `delete from public.news_bot_settings where telegram_channel_id = '${channelId}'`,
        `delete from public.telegram_updates where update_id in (${updateIds})`,
      ]) {
        await pool.query(statement);
      }
      await pool.query("commit");
    } catch (error) {
      await pool.query("rollback").catch(() => {});
      throw new Error(
        `teardown failed, so the next scenario would start from dirty state: ${
          (error as Error).message
        }`,
        { cause: error },
      );
    }

    await moduleRef.close();
    await pool.end().catch(() => undefined);
  }
}

function describe(error: unknown): string {
  return `${(error as Error)?.name ?? "Error"}: ${
    (error as Error)?.message ?? String(error)
  }`;
}
