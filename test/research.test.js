import test from "node:test";
import assert from "node:assert/strict";
import {
  matchPrimarySource,
  rankCandidates,
  runResearch,
  scoreCandidate,
} from "../src/research.js";

const NOW = new Date("2026-06-27T00:00:00Z");
const PRIMARY_SOURCE = {
  id: "source-1",
  feed_url: "https://example.com/feed",
  source_type: "rss",
  is_primary: true,
  reliability_score: 90,
};

function candidate(overrides = {}) {
  return {
    title: "New AI agent released",
    canonicalUrl: "https://example.com/agent",
    author: "Research Team",
    publishedAt: "2026-06-26T18:00:00Z",
    summary: "A new agent model for research.",
    contentHash: "hash",
    source: PRIMARY_SOURCE,
    ...overrides,
  };
}

test("scoreCandidate rewards primary, recent, reliable, relevant sources", () => {
  const high = scoreCandidate(candidate(), PRIMARY_SOURCE, {
    now: NOW,
    keywords: ["agent", "research"],
  });
  const low = scoreCandidate(
    candidate({ publishedAt: "2026-06-24T00:00:00Z" }),
    { ...PRIMARY_SOURCE, is_primary: false, reliability_score: 40 },
    { now: NOW, keywords: ["unmatched"] },
  );

  assert.ok(high > low);
});

test("rankCandidates removes old and duplicate candidates deterministically", () => {
  const ranked = rankCandidates(
    [
      candidate(),
      candidate({ title: "Duplicate", source: { ...PRIMARY_SOURCE, reliability_score: 60 } }),
      candidate({
        canonicalUrl: "https://example.com/old",
        publishedAt: "2026-06-20T00:00:00Z",
      }),
    ],
    { now: NOW, windowHours: 48, keywords: ["agent"] },
  );

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].title, "New AI agent released");
});

test("Reddit discoveries can only map to configured primary domains", () => {
  const sources = [
    {
      ...PRIMARY_SOURCE,
      homepage_url: "https://openai.com/",
    },
  ];

  assert.equal(
    matchPrimarySource("https://openai.com/news/release", sources)?.id,
    PRIMARY_SOURCE.id,
  );
  assert.equal(
    matchPrimarySource("https://fake-openai.example/news", sources),
    undefined,
  );
});

test("runResearch persists candidates and completes the run", async () => {
  const calls = [];
  const repository = {
    async startSearchRun() {
      calls.push("start");
      return { id: "run-1" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {
      calls.push("checked");
    },
    async createOrResumeArticleCandidate(article) {
      calls.push(["article", article.canonical_url]);
      return { id: "article-1", ...article };
    },
    async saveRawContent(rawContent) {
      calls.push(["raw", rawContent.article_id]);
    },
    async finishSearchRun(id, details) {
      calls.push(["finish", id, details.resultCount]);
    },
    async failSearchRun() {
      calls.push("fail");
    },
  };
  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [candidate()],
    fetchArticleImpl: async () => ({
      text: "Extracted primary article evidence.",
      contentHash: "article-hash",
      finalUrl: "https://example.com/agent",
    }),
  });

  assert.equal(result.selected.article.id, "article-1");
  assert.deepEqual(calls, [
    "start",
    "checked",
    ["article", "https://example.com/agent"],
    ["raw", "article-1"],
    ["raw", "article-1"],
    ["finish", "run-1", 1],
  ]);
  assert.equal(result.selected.evidenceText, "Extracted primary article evidence.");
});

test("runResearch rejects a cross-publisher duplicate and selects the next distinct story", async () => {
  const decisions = [];
  const transitions = [];
  const extractedUrls = [];
  let articleSequence = 0;
  let finished;
  const duplicateCandidate = candidate({
    title: "AI models can escape test environments",
    canonicalUrl: "https://second-publisher.example/model-escape",
    summary:
      "A technology publication revisits a Kimi attempt to bypass a cybersecurity test.",
    contentHash: "duplicate-hash",
  });
  const distinctCandidate = candidate({
    title: "Scientists map a deep-sea coral nursery",
    canonicalUrl: "https://example.com/coral-nursery",
    summary: "The Atlantic habitat contains hundreds of new coral colonies.",
    contentHash: "distinct-hash",
  });
  const repository = {
    async startSearchRun() {
      return { id: "run-story-dedup" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      articleSequence += 1;
      return { id: `article-${articleSequence}`, ...article };
    },
    async saveRawContent() {},
    async listRecentPublishedStories() {
      return [
        {
          article_id: "published-kimi",
          title: "AI models can escape test environments",
          feed_summary:
            "Researchers reported that a Kimi model bypassed a test harness.",
          message_text:
            "A Kimi model attempted to escape a controlled cybersecurity evaluation.",
          telegram_channel_id: "@HonestAINews",
          telegram_message_id: 37,
          published_at: "2026-06-26T12:00:00.000Z",
          story_fingerprint: null,
        },
      ];
    },
    async recordStoryDedupDecision(input) {
      decisions.push(input);
      return input;
    },
    async transitionArticle(id, from, to) {
      transitions.push([id, from, to]);
    },
    async finishSearchRun(_id, details) {
      finished = details;
    },
    async failSearchRun() {},
  };
  const aiProvider = {
    async generateStructured(request) {
      if (request.schemaName === "news_candidate_curation") {
        return {
          value: {
            rankedCandidateIds: ["candidate-2", "candidate-1"],
          },
          usageEvents: [],
        };
      }
      assert.equal(request.schemaName, "semantic_story_deduplication");
      return {
        value: {
          relation: "same_story",
          matchedPublishedArticleId: "published-kimi",
          confidence: 0.97,
          reason: "Same Kimi model escape event",
        },
        usageEvents: [],
      };
    },
  };

  const result = await runResearch({
    repository,
    query: "world news",
    now: NOW,
    discoveryProvider: aiProvider,
    retryImpl: async (operation) => operation(),
    fetchFeedImpl: async () => [duplicateCandidate, distinctCandidate],
    fetchArticleImpl: async (url) => {
      extractedUrls.push(url);
      throw new Error("Publisher blocked extraction");
    },
  });

  assert.equal(result.selected.canonicalUrl, distinctCandidate.canonicalUrl);
  assert.equal(result.selected.evidenceKind, "primary_feed_summary");
  assert.deepEqual(extractedUrls, [distinctCandidate.canonicalUrl]);
  const duplicateDecision = decisions.find(
    (entry) => entry.relation === "duplicate",
  );
  assert.equal(duplicateDecision.duplicateOfArticleId, "published-kimi");
  assert.equal(
    decisions.filter((entry) => entry.relation === "distinct").length,
    1,
  );
  assert.equal(transitions.length, 1);
  assert.deepEqual(transitions[0].slice(1), ["discovered", "rejected"]);
  assert.equal(finished.metadata.story_deduplication.duplicate_count, 1);
  assert.equal(finished.metadata.story_deduplication.compared_count, 2);
  assert.equal(finished.metadata.story_deduplication.semantic_ai_call_count, 1);
  assert.equal(finished.metadata.story_deduplication.semantic_ai_call_limit, 3);
});

test("runResearch spends at most three one-shot semantic provider attempts and never falls back to rejected evidence", async () => {
  const decisions = [];
  const extractedUrls = [];
  let semanticAttempts = 0;
  let articleSequence = 0;
  const candidates = Array.from({ length: 5 }, (_, index) =>
    candidate({
      title: `AI models can escape test environments report ${index + 1}`,
      canonicalUrl: `https://publisher-${index + 1}.example/model-escape`,
      summary:
        "Researchers examine the Kimi model attempt to bypass a controlled cybersecurity test harness.",
      contentHash: `ambiguous-${index + 1}`,
    }),
  );
  const repository = {
    async startSearchRun() {
      return { id: "run-semantic-budget" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      articleSequence += 1;
      return { id: `ambiguous-article-${articleSequence}`, ...article };
    },
    async saveRawContent() {},
    async listRecentPublishedStories() {
      return [
        {
          article_id: "published-kimi-budget",
          title: "Kimi AI model escaped cybersecurity testing",
          feed_summary:
            "Researchers reported that a Kimi model tried to bypass its test harness.",
          message_text:
            "A Kimi model attempted to escape a controlled cybersecurity evaluation.",
          telegram_channel_id: "@HonestAINews",
          telegram_message_id: 37,
          published_at: "2026-06-26T12:00:00.000Z",
          story_fingerprint: null,
        },
      ];
    },
    async recordStoryDedupDecision(input) {
      decisions.push(input);
      return input;
    },
    async transitionArticle() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };
  const aiProvider = {
    async generateStructured(request) {
      assert.equal(request.schemaName, "news_candidate_curation");
      return {
        value: {
          rankedCandidateIds: candidates.map(
            (_item, index) => `candidate-${index + 1}`,
          ),
        },
        usageEvents: [],
      };
    },
    async generateStructuredOnce(request) {
      assert.equal(request.schemaName, "semantic_story_deduplication");
      semanticAttempts += 1;
      throw new Error("semantic provider unavailable");
    },
  };

  await assert.rejects(
    runResearch({
      repository,
      query: "AI news",
      now: NOW,
      discoveryProvider: aiProvider,
      retryImpl: async (operation) => operation(),
      fetchFeedImpl: async () => candidates,
      fetchArticleImpl: async (url) => {
        extractedUrls.push(url);
        throw new Error("must not extract uncertain candidates");
      },
    }),
    /No ranked news evidence could be extracted/,
  );

  assert.equal(semanticAttempts, 3);
  assert.equal(decisions.length, 5);
  assert.deepEqual(
    decisions.map((entry) => entry.relation),
    ["uncertain", "uncertain", "uncertain", "uncertain", "uncertain"],
  );
  assert.deepEqual(extractedUrls, []);
});

test("runResearch falls back to persisted primary RSS evidence when pages block extraction", async () => {
  let finished;
  const repository = {
    async startSearchRun() {
      return { id: "run-feed-fallback" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { id: "article-feed-fallback", ...article };
    },
    async saveRawContent() {},
    async finishSearchRun(_id, details) {
      finished = details;
    },
    async failSearchRun() {},
  };

  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [candidate()],
    fetchArticleImpl: async () => {
      throw new Error("Primary page request failed with HTTP 403");
    },
    retryImpl: (operation) => operation(),
  });

  assert.equal(result.selected.evidenceKind, "primary_feed_summary");
  assert.equal(result.selected.evidenceText, candidate().summary);
  assert.equal(result.extractionErrors.length, 1);
  assert.equal(
    finished.metadata.selected_evidence_kind,
    "primary_feed_summary",
  );
});

test("runResearch accepts broad web-search results and extracts the direct article", async () => {
  const saved = [];
  const searched = [];
  const extracted = [];
  let searchCalls = 0;
  const repository = {
    async startSearchRun() {
      return { id: "run-provider-search" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      saved.push(article);
      return { id: "article-provider-search", ...article };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };

  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [],
    discoveryProvider: {
      async searchNews(options) {
        searchCalls += 1;
        searched.push(options);
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          items: [
            {
              title: "Independent newsroom report",
              url: "https://news.example.net/ai-report",
              summary: "A direct article discovered across the public web.",
              publishedAt: "2026-06-26T20:00:00Z",
            },
            {
              title: "Second report from the same publisher",
              url: "https://news.example.net/second-report",
              summary: "This lower-ranked duplicate publisher is omitted.",
              publishedAt: "2026-06-26T19:30:00Z",
            },
            {
              title: "Report from another publisher",
              url: "https://another.example.org/ai-report",
              summary: "A diverse second publisher remains eligible.",
              publishedAt: "2026-06-26T19:00:00Z",
            },
          ],
        };
      },
    },
    fetchArticleImpl: async (url) => {
      extracted.push(url);
      return {
        text: "Evidence extracted from the direct newsroom article.",
        contentHash: "web-article-hash",
        finalUrl: url,
      };
    },
    retryImpl: (operation) => operation(),
  });

  assert.equal(searchCalls, 1);
  assert.deepEqual(searched[0], {
    query: "AI news",
    windowHours: 48,
    limit: 8,
  });
  assert.equal(saved.length, 2);
  assert.equal(saved[0].source_id, null);
  assert.equal(saved[0].metadata.discovery_kind, "openai_web_search");
  assert.equal(saved[0].metadata.verification_status, "web_source");
  assert.equal(saved[0].metadata.publisher, "news.example.net");
  assert.equal(saved[1].metadata.publisher, "another.example.org");
  assert.deepEqual(extracted, ["https://news.example.net/ai-report"]);
  assert.equal(result.selected.verificationStatus, "web_source");
  assert.equal(
    result.selected.evidenceText,
    "Evidence extracted from the direct newsroom article.",
  );
});

test("runResearch skips paid web search when RSS has a recent candidate", async () => {
  let searchCalls = 0;
  const repository = {
    async startSearchRun() {
      return { id: "run-always-search" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { id: `article-${article.title}`, ...article };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };

  await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [candidate()],
    discoveryProvider: {
      async searchNews() {
        searchCalls += 1;
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          items: [],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: "Extracted article evidence.",
      contentHash: "article-hash",
      finalUrl: url,
    }),
  });

  assert.equal(searchCalls, 0);
});

test("runResearch saves a validated discovered RSS feed before article-search fallback", async () => {
  let articleSearchCalls = 0;
  let savedSource;
  let finished;
  const repository = {
    async startSearchRun() {
      return { id: "run-source-discovery" };
    },
    async listEnabledSources() {
      return [];
    },
    async claimSourceDiscovery() {
      return true;
    },
    async upsertDiscoveredSource(source) {
      savedSource = source;
      return {
        id: "source-discovered",
        name: source.name,
        homepage_url: source.homepageUrl,
        feed_url: source.feedUrl,
        source_type: "rss",
        reliability_score: 65,
        is_primary: false,
      };
    },
    async completeSourceDiscovery() {
      return true;
    },
    async createOrResumeArticleCandidate(article) {
      return { id: "article-discovered", ...article };
    },
    async saveRawContent() {},
    async finishSearchRun(_id, details) {
      finished = details;
    },
    async failSearchRun() {},
  };
  const result = await runResearch({
    repository,
    query: "History news",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: ["history"],
      customTopics: [],
      version: 1,
    },
    discoveryProvider: {
      async searchFeeds() {
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          usageEvents: [],
          items: [
            {
              name: "History Publisher",
              feedUrl: "https://history.example.org/rss.xml",
              homepageUrl: "https://history.example.org/",
            },
          ],
        };
      },
      async searchNews() {
        articleSearchCalls += 1;
        return { provider: "openai", model: "test", items: [] };
      },
    },
    fetchFeedImpl: async () => [
      candidate({
        title: "New archaeological finding",
        canonicalUrl: "https://history.example.org/finding",
        contentHash: "history-hash",
      }),
    ],
    fetchArticleImpl: async (url) => ({
      text: "Direct evidence from the discovered publisher.",
      contentHash: "history-article-hash",
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
  });

  assert.equal(articleSearchCalls, 0);
  assert.equal(savedSource.feedUrl, "https://history.example.org/rss.xml");
  assert.deepEqual(savedSource.topicCodes, ["history"]);
  assert.equal(result.selected.source.id, "source-discovered");
  assert.equal(result.selected.verificationStatus, "web_source");
  assert.equal(finished.metadata.source_discovery.count, 1);
});

test("runResearch uses tool-free AI curation to choose among feed candidates", async () => {
  let finished;
  let curationRequest;
  const repository = {
    async startSearchRun() {
      return { id: "run-feed-curation" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { id: `article-${article.title}`, ...article };
    },
    async saveRawContent() {},
    async finishSearchRun(_id, details) {
      finished = details;
    },
    async failSearchRun() {},
  };
  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [
      candidate(),
      candidate({
        title: "More important independent discovery",
        canonicalUrl: "https://example.com/important",
        contentHash: "important-hash",
      }),
    ],
    discoveryProvider: {
      async generateStructured(request) {
        curationRequest = request;
        return {
          value: { rankedCandidateIds: ["candidate-2"] },
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          usageEvents: [],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: `Evidence from ${url}`,
      contentHash: "article-hash",
      finalUrl: url,
    }),
  });

  assert.equal(curationRequest.usageOperation, "feed_candidate_curation");
  assert.equal(result.selected.title, "More important independent discovery");
  assert.equal(finished.metadata.provider_discovery, null);
  assert.equal(finished.metadata.candidate_curation.provider, "openai");
  assert.equal(finished.metadata.free_discovery.feed_candidate_count, 2);
});

test("non-AI settings skip static AI feeds and allow provider-only research", async () => {
  let feedCalled = false;
  let providerRequest;
  const rawWrites = [];
  const repository = {
    async startSearchRun(input) {
      assert.equal(input.metadata.news_settings.languageCode, "uk");
      return { id: "run-nature" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { id: "article-nature", ...article };
    },
    async saveRawContent(content) {
      rawWrites.push(content);
    },
    async finishSearchRun() {},
    async failSearchRun() {},
  };

  const result = await runResearch({
    repository,
    query: "Nature and animals",
    keywords: ["nature", "animals"],
    now: NOW,
    newsSettings: {
      languageCode: "uk",
      topicCodes: ["nature", "animals"],
      customTopics: ["Морська біологія"],
      version: 2,
    },
    fetchFeedImpl: async () => {
      feedCalled = true;
      return [candidate()];
    },
    discoveryProvider: {
      async searchNews(request) {
        providerRequest = request;
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          items: [
            {
              title: "Нове дослідження тварин",
              url: "https://nature.example.org/animal-study",
              summary: "Дослідники описали нову поведінку тварин.",
              publishedAt: "2026-06-26T20:00:00Z",
            },
          ],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: "Direct evidence from the nature article.",
      contentHash: "nature-article-hash",
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
  });

  assert.equal(feedCalled, false);
  assert.equal(providerRequest.languageCode, "uk");
  assert.deepEqual(providerRequest.topicCodes, ["nature", "animals"]);
  assert.deepEqual(providerRequest.customTopics, ["Морська біологія"]);
  assert.equal(result.selected.title, "Нове дослідження тварин");
  assert.equal(rawWrites[0].language_code, "uk");
  assert.equal(rawWrites[1].language_code, null);
});

test("custom-only settings use free GDELT discovery before paid providers", async () => {
  let gdeltRequest;
  let providerCalls = 0;
  const gdeltSource = {
    id: "source-gdelt",
    name: "GDELT DOC 2.0",
    homepage_url: "https://www.gdeltproject.org/",
    feed_url: "https://api.gdeltproject.org/api/v2/doc/doc",
    source_type: "api",
    reliability_score: 75,
    is_primary: false,
    topic_codes: ["world", "science"],
  };
  const repository = {
    async startSearchRun() {
      return { id: "run-custom-gdelt" };
    },
    async listEnabledSources() {
      return [gdeltSource];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { id: "article-custom-gdelt", ...article };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };

  const result = await runResearch({
    repository,
    query: "Ocean exploration",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: [],
      customTopics: ["Ocean exploration"],
      version: 1,
    },
    fetchGdeltImpl: async (_url, options) => {
      gdeltRequest = options;
      return [
        candidate({
          title: "Ocean expedition result",
          canonicalUrl: "https://ocean.example.org/expedition",
          contentHash: "ocean-hash",
          publisher: "Ocean Institute",
        }),
      ];
    },
    discoveryProvider: {
      async searchNews() {
        providerCalls += 1;
        return { provider: "openai", model: "test", items: [] };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: "Direct ocean research evidence.",
      contentHash: "ocean-article-hash",
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
  });

  assert.deepEqual(gdeltRequest.customTopics, ["Ocean exploration"]);
  assert.equal(providerCalls, 0);
  assert.equal(result.selected.title, "Ocean expedition result");
});

test("runResearch uses a web-grounded search summary when the publisher blocks extraction", async () => {
  const repository = {
    async startSearchRun() {
      return { id: "run-web-summary" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(article) {
      return { id: "article-web-summary", ...article };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };

  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    fetchFeedImpl: async () => [],
    discoveryProvider: {
      async searchNews() {
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          items: [
            {
              title: "Publisher-blocked report",
              url: "https://news.example.net/blocked-report",
              summary: "A web-grounded description of the reported event.",
              publishedAt: "2026-06-26T20:00:00Z",
            },
          ],
        };
      },
    },
    fetchArticleImpl: async () => {
      throw new Error("Publisher returned HTTP 403");
    },
    retryImpl: (operation) => operation(),
  });

  assert.equal(result.selected.verificationStatus, "web_search_summary");
  assert.equal(result.selected.evidenceKind, "web_search_summary");
  assert.equal(
    result.selected.evidenceText,
    "A web-grounded description of the reported event.",
  );
  assert.equal(result.extractionErrors.length, 1);
});

test("runResearch fails closed without any discovery sources", async () => {
  let failedMessage;
  const repository = {
    async startSearchRun() {
      return { id: "run-1" };
    },
    async listEnabledSources() {
      return [];
    },
    async failSearchRun(_id, error) {
      failedMessage = error.message;
    },
  };

  await assert.rejects(
    runResearch({ repository, query: "AI news", now: NOW }),
    /No enabled news discovery sources/,
  );
  assert.equal(failedMessage, "No enabled news discovery sources are configured");
});

test("runResearch does not reset or redraft an existing canonical URL", async () => {
  let extractionCalled = false;
  let failedMessage;
  const repository = {
    async startSearchRun() {
      return { id: "run-duplicate" };
    },
    async listEnabledSources() {
      return [PRIMARY_SOURCE];
    },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate() {
      return null;
    },
    async failSearchRun(_id, error) {
      failedMessage = error.message;
    },
  };

  await assert.rejects(
    runResearch({
      repository,
      query: "AI news",
      now: NOW,
      fetchFeedImpl: async () => [candidate()],
      fetchArticleImpl: async () => {
        extractionCalled = true;
      },
    }),
    /No new news articles/,
  );
  assert.equal(extractionCalled, false);
  assert.equal(failedMessage, "No new news articles were found");
});
