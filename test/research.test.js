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
      async generateStructured(request) {
        if (request.schemaName === "news_candidate_curation") {
          return {
            provider: "openai",
            model: "gpt-5.4-2026-03-05",
            usageEvents: [],
            value: { rankedCandidateIds: ["candidate-1"] },
          };
        }
        assert.equal(request.schemaName, "excluded_topic_classification");
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          usageEvents: [],
          value: {
            assessments: [
              { topicCode: "war_conflict", relation: "unrelated" },
            ],
          },
        };
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
  assert.deepEqual(
    finished.metadata.excluded_topic_policy.stages.map(({ stage }) => stage),
    ["discovery", "discovered_feed", "selected_evidence"],
  );
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

test("invalid curation IDs still persist returned usage once before safe ranking fallback", async () => {
  const usageWrites = [];
  let finished;
  const repository = {
    async startSearchRun() { return { id: "run-invalid-curation-usage" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(value) {
      return { id: "invalid-curation-article", ...value };
    },
    async saveRawContent() {},
    async recordAiUsage(value) {
      usageWrites.push(value);
      return value;
    },
    async finishSearchRun(_id, details) { finished = details; },
    async failSearchRun() {},
  };
  const result = await runResearch({
    repository,
    query: "AI news",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: ["ai"],
      customTopics: [],
      excludedTopicCodes: [],
      version: 4,
    },
    fetchFeedImpl: async () => [candidate()],
    discoveryProvider: {
      async generateStructured() {
        return {
          value: {
            rankedCandidateIds: ["candidate-1", "candidate-1"],
          },
          provider: "configured-provider",
          model: "configured-model",
          usageEvents: [
            {
              provider: "configured-provider",
              providerResponseId: "curation-invalid-response",
              model: "configured-model",
              operation: "feed_candidate_curation",
              inputTokens: 10,
              outputTokens: 2,
            },
          ],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: "Full verified evidence.",
      contentHash: "invalid-curation-evidence",
      finalUrl: url,
    }),
  });

  assert.equal(result.selected.article.id, "invalid-curation-article");
  assert.equal(usageWrites.length, 1);
  assert.equal(usageWrites[0].providerResponseId, "curation-invalid-response");
  assert.equal(
    finished.metadata.candidate_curation.error,
    "invalid_candidate_ids",
  );
});

test("non-AI settings skip static AI feeds and allow provider-only research", async () => {
  let feedCalled = false;
  let providerRequest;
  let finished;
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
    async finishSearchRun(_id, details) {
      finished = details;
    },
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
      async generateStructured(request) {
        assert.equal(request.schemaName, "excluded_topic_classification");
        return {
          provider: "openai",
          model: "gpt-5.4-2026-03-05",
          usageEvents: [],
          value: {
            assessments: [
              { topicCode: "war_conflict", relation: "unrelated" },
            ],
          },
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
  assert.deepEqual(providerRequest.excludedTopics, [
    {
      code: "war_conflict",
      description:
        "War, armed conflict, combat operations, military attacks, and their direct consequences.",
    },
  ]);
  assert.equal(result.selected.title, "Нове дослідження тварин");
  assert.equal(rawWrites[0].language_code, "uk");
  assert.equal(rawWrites[1].language_code, null);
  assert.deepEqual(
    finished.metadata.excluded_topic_policy.stages.map(({ stage }) => stage),
    ["discovery", "provider_search", "selected_evidence"],
  );
});

test("provider-only research with empty exclusions omits excludedTopics exactly", async () => {
  let providerRequest;
  const repository = {
    async startSearchRun() { return { id: "run-provider-empty-exclusions" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(value) {
      return { id: "provider-empty-exclusions-article", ...value };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };
  const result = await runResearch({
    repository,
    query: "Nature news",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: ["nature"],
      customTopics: [],
      excludedTopicCodes: [],
      version: 3,
    },
    fetchFeedImpl: async () => {
      throw new Error("non-AI settings must skip the static AI feed");
    },
    discoveryProvider: {
      async searchNews(request) {
        providerRequest = request;
        return {
          provider: "openai",
          model: "configured-model",
          usageEvents: [],
          items: [
            {
              title: "A verified nature result",
              url: "https://nature.example.org/result",
              summary: "Researchers published a verified result.",
              publishedAt: "2026-06-26T20:00:00Z",
            },
          ],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: "Full verified nature evidence.",
      contentHash: "nature-empty-exclusions",
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
  });

  assert.equal(result.selected.article.id, "provider-empty-exclusions-article");
  assert.equal(Object.hasOwn(providerRequest, "excludedTopics"), false);
  assert.deepEqual(providerRequest, {
    query: "Nature news",
    windowHours: 48,
    limit: 8,
    languageCode: "en",
    topicCodes: ["nature"],
    customTopics: [],
  });
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
      excludedTopicCodes: [],
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

test("excluded-topic policy filters aggregated feed candidates before ranking and curation", async () => {
  const persisted = [];
  let curationRequest;
  let finished;
  const repository = {
    async startSearchRun() { return { id: "run-policy-before-ranking" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(value) {
      persisted.push(value);
      return { id: `article-${persisted.length}`, ...value };
    },
    async saveRawContent() {},
    async finishSearchRun(_id, details) { finished = details; },
    async failSearchRun() {},
  };
  const result = await runResearch({
    repository,
    query: "world news",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: ["ai"],
      customTopics: [],
      excludedTopicCodes: ["war_conflict"],
      version: 7,
    },
    fetchFeedImpl: async () => [
      candidate({
        title: "Missile strike kills three civilians in overnight attack",
        canonicalUrl: "https://example.com/blocked-conflict",
        contentHash: "blocked-conflict",
      }),
      candidate({
        title: "Quantum sensor detects a new material phase",
        canonicalUrl: "https://example.com/quantum-sensor",
        summary: "Researchers verified the measurement independently.",
        contentHash: "quantum-sensor",
      }),
    ],
    discoveryProvider: {
      async generateStructured(request) {
        if (request.schemaName === "excluded_topic_classification") {
          return {
            value: {
              assessments: [
                { topicCode: "war_conflict", relation: "unrelated" },
              ],
            },
            provider: "configured-provider",
            model: "configured-model",
            usageEvents: [],
          };
        }
        curationRequest = request;
        return {
          value: { rankedCandidateIds: ["candidate-1"] },
          provider: "configured-provider",
          model: "configured-model",
          usageEvents: [],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: "Verified scientific evidence without conflict content.",
      contentHash: "scientific-evidence",
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
  });

  assert.equal(result.selected.canonicalUrl, "https://example.com/quantum-sensor");
  assert.equal(persisted.length, 1);
  assert.equal(curationRequest.input.candidates.length, 1);
  assert.equal(
    curationRequest.input.candidates[0].title,
    "Quantum sensor detects a new material phase",
  );
  assert.equal(finished.metadata.excluded_topic_policy.blocked_count, 1);
  assert.equal(
    JSON.stringify(finished.metadata.excluded_topic_policy).includes(
      "Missile strike",
    ),
    false,
  );
});

for (const acquisitionKind of ["reddit", "gdelt"]) {
  test(`${acquisitionKind} candidates are policy-filtered before persistence and extraction`, async () => {
    const logs = [];
    let persisted = 0;
    let extracted = 0;
    let finished;
    const apiSource =
      acquisitionKind === "reddit"
        ? {
            id: "source-reddit",
            name: "Reddit discovery",
            homepage_url: "https://www.reddit.com/",
            feed_url: "https://www.reddit.com/r/worldnews/new.json",
            source_type: "api",
            reliability_score: 40,
            is_primary: false,
            topic_codes: ["ai"],
          }
        : {
            id: "source-gdelt-policy",
            name: "GDELT DOC 2.0",
            homepage_url: "https://www.gdeltproject.org/",
            feed_url: "https://api.gdeltproject.org/api/v2/doc/doc",
            source_type: "api",
            reliability_score: 75,
            is_primary: false,
            topic_codes: ["ai"],
          };
    const repository = {
      async startSearchRun() {
        return { id: `run-${acquisitionKind}-policy` };
      },
      async listEnabledSources() {
        return acquisitionKind === "reddit"
          ? [PRIMARY_SOURCE, apiSource]
          : [apiSource];
      },
      async markSourceChecked() {},
      async createOrResumeArticleCandidate() {
        persisted += 1;
      },
      async finishSearchRun(_id, details) { finished = details; },
      async failSearchRun() {
        throw new Error("must not fail a policy-filtered terminal run");
      },
    };
    const blockedCandidate = candidate({
      title: "Missile strike kills three civilians in overnight attack",
      canonicalUrl: "https://example.com/current-conflict-event",
      contentHash: `${acquisitionKind}-conflict-event`,
      discoveryKind: acquisitionKind,
    });
    const discoveryProvider =
      acquisitionKind === "reddit"
        ? {
            async searchNews() {
              return {
                provider: "openai",
                model: "configured-model",
                items: [],
                usageEvents: [],
              };
            },
          }
        : undefined;

    await assert.rejects(
      runResearch({
        repository,
        query: "world news",
        now: NOW,
        newsSettings: {
          languageCode: "en",
          topicCodes: ["ai"],
          customTopics: [],
          excludedTopicCodes: ["war_conflict"],
          version: 7,
        },
        fetchFeedImpl: async () => [],
        fetchRedditImpl: async () => [blockedCandidate],
        fetchGdeltImpl: async () => [blockedCandidate],
        fetchArticleImpl: async () => {
          extracted += 1;
          throw new Error("blocked candidate must not be extracted");
        },
        discoveryProvider,
        retryImpl: (operation) => operation(),
        log: { info(value) { logs.push(JSON.parse(value)); } },
      }),
      /excluded-topic policy/,
    );

    assert.equal(persisted, 0);
    assert.equal(extracted, 0);
    assert.equal(logs[0].stage, "discovery");
    assert.equal(logs[0].deterministicBlockedCount, 1);
    assert.equal(finished.resultCount, 0);
    assert.equal(finished.metadata.status, "no_candidates");
    assert.equal(finished.metadata.reason, "excluded_topic_policy");
    assert.equal(finished.metadata.terminal_stage, "acquisition");
    assert.equal(finished.metadata.excluded_topic_policy.blocked_count, 1);
    assert.equal(
      JSON.stringify(finished.metadata).includes("current-conflict-event"),
      false,
    );
  });
}

test("selected full evidence is reclassified, safely rejected, and research continues deterministically", async () => {
  const transitions = [];
  const usageWrites = [];
  let articleSequence = 0;
  let finished;
  const repository = {
    async startSearchRun() { return { id: "run-policy-evidence-recheck" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(value) {
      articleSequence += 1;
      return { id: `policy-article-${articleSequence}`, ...value };
    },
    async saveRawContent() {},
    async transitionArticle(...args) { transitions.push(args); },
    async recordAiUsage(value) { usageWrites.push(value); return value; },
    async finishSearchRun(_id, details) { finished = details; },
    async failSearchRun() {},
  };
  const first = candidate({
    title: "City publishes an overnight situation report",
    canonicalUrl: "https://example.com/a-situation-report",
    summary: "Officials released a short update.",
    contentHash: "situation-report",
  });
  const second = candidate({
    title: "Scientists map a deep-sea coral nursery",
    canonicalUrl: "https://example.com/b-coral-nursery",
    summary: "The habitat contains hundreds of new coral colonies.",
    contentHash: "coral-nursery",
  });
  const result = await runResearch({
    repository,
    query: "world news",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: ["ai"],
      customTopics: [],
      excludedTopicCodes: ["war_conflict"],
      version: 8,
    },
    fetchFeedImpl: async () => [first, second],
    discoveryProvider: {
      async generateStructured(request) {
        if (request.schemaName === "news_candidate_curation") {
          return {
            value: {
              rankedCandidateIds: ["candidate-1", "candidate-2"],
            },
            provider: "configured-provider",
            model: "configured-model",
            usageEvents: [],
          };
        }
        assert.equal(request.schemaName, "excluded_topic_classification");
        const isConflictEvidence = /combat operations/i.test(
          request.input.article.text,
        );
        return {
          value: {
            assessments: [
              {
                topicCode: "war_conflict",
                relation: isConflictEvidence ? "main_subject" : "unrelated",
              },
            ],
          },
          provider: "configured-provider",
          model: "configured-model",
          usageEvents: [
            {
              provider: "configured-provider",
              model: "configured-model",
              operation: "excluded_topic_classification",
            },
          ],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: url.includes("situation-report")
        ? "The full report is substantially about military combat operations."
        : "Scientists documented coral colonies using verified survey data.",
      contentHash: `evidence-${url}`,
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
  });

  assert.equal(result.selected.canonicalUrl, second.canonicalUrl);
  assert.deepEqual(transitions[0].slice(0, 3), [
    "policy-article-1",
    "discovered",
    "rejected",
  ]);
  assert.deepEqual(
    transitions[0][3].metadata.excluded_topic_policy,
    {
      stage: "selected_evidence",
      policy_codes: ["war_conflict"],
      prompt_version: "excluded-topics-v1",
      reason: "semantic_main_subject",
      policy_code: "war_conflict",
    },
  );
  assert.equal(usageWrites.length, 4);
  assert.ok(
    usageWrites.every(
      (entry) => entry.operation === "excluded_topic_classification",
    ),
  );
  assert.equal(usageWrites[0].articleId, null);
  assert.equal(usageWrites[1].articleId, null);
  assert.equal(usageWrites[2].articleId, "policy-article-1");
  assert.equal(usageWrites[3].articleId, "policy-article-2");
  assert.equal(
    finished.metadata.excluded_topic_policy.evidence_blocked_count,
    1,
  );
});

for (const evidencePath of [
  "full_extraction",
  "community_summary",
  "web_summary_fallback",
  "feed_summary_fallback",
]) {
  test(`${evidencePath} policy transition failure propagates without a false durable rejection`, async () => {
    const transitionFailure = new Error(
      `transition persistence failed for ${evidencePath}`,
    );
    let failedWith;
    let finishCalls = 0;
    let transitionCalls = 0;
    let policyCalls = 0;
    let fetchCalls = 0;
    const repository = {
      async startSearchRun() { return { id: `run-${evidencePath}-transition` }; },
      async listEnabledSources() { return [PRIMARY_SOURCE]; },
      async markSourceChecked() {},
      async createOrResumeArticleCandidate(value) {
        return { id: `${evidencePath}-article`, ...value };
      },
      async saveRawContent() {},
      async transitionArticle() {
        transitionCalls += 1;
        throw transitionFailure;
      },
      async finishSearchRun() { finishCalls += 1; },
      async failSearchRun(_id, error) { failedWith = error; },
    };
    const input = candidate({
      title: "City publishes a situation report",
      summary: "The evidence is substantially about combat operations.",
      contentHash: `${evidencePath}-hash`,
      ...(evidencePath === "community_summary" ? { unverified: true } : {}),
      ...(evidencePath === "web_summary_fallback"
        ? { verificationStatus: "web_source" }
        : {}),
    });

    await assert.rejects(
      runResearch({
        repository,
        query: "world news",
        now: NOW,
        newsSettings: {
          languageCode: "en",
          topicCodes: ["ai"],
          customTopics: [],
          excludedTopicCodes: ["war_conflict"],
          version: 14,
        },
        fetchFeedImpl: async () => [input],
        discoveryProvider: {
          async generateStructured(request) {
            if (request.schemaName === "news_candidate_curation") {
              return {
                value: { rankedCandidateIds: ["candidate-1"] },
                usageEvents: [],
              };
            }
            policyCalls += 1;
            return {
              value: {
                assessments: [
                  {
                    topicCode: "war_conflict",
                    relation: policyCalls === 1 ? "unrelated" : "main_subject",
                  },
                ],
              },
              provider: "configured-provider",
              model: "configured-model",
              usageEvents: [],
            };
          },
        },
        fetchArticleImpl: async (url) => {
          fetchCalls += 1;
          if (evidencePath.endsWith("fallback")) {
            throw new Error("publisher extraction failed");
          }
          return {
            text: "Full evidence substantially about combat operations.",
            contentHash: `${evidencePath}-evidence`,
            finalUrl: url,
          };
        },
        retryImpl: (operation) => operation(),
        log: { info() {} },
      }),
      (error) => error === transitionFailure,
    );

    assert.equal(failedWith, transitionFailure);
    assert.equal(finishCalls, 0);
    assert.equal(transitionCalls, 1);
    assert.equal(policyCalls, 2);
    assert.equal(fetchCalls, evidencePath === "community_summary" ? 0 : 1);
  });
}

test("policy transition failure preserves failSearchRun replacement semantics", async () => {
  const transitionFailure = new Error("transition persistence failed");
  const failReplacement = new Error("failSearchRun replacement");
  let failedWith;
  await assert.rejects(
    runResearch({
      repository: {
        async startSearchRun() { return { id: "run-transition-replacement" }; },
        async listEnabledSources() { return [PRIMARY_SOURCE]; },
        async markSourceChecked() {},
        async createOrResumeArticleCandidate(value) {
          return { id: "transition-replacement-article", ...value };
        },
        async saveRawContent() {},
        async transitionArticle() { throw transitionFailure; },
        async finishSearchRun() { throw new Error("must not finish"); },
        async failSearchRun(_id, error) {
          failedWith = error;
          throw failReplacement;
        },
      },
      query: "world news",
      now: NOW,
      newsSettings: {
        languageCode: "en",
        topicCodes: ["ai"],
        customTopics: [],
        excludedTopicCodes: ["war_conflict"],
        version: 15,
      },
      fetchFeedImpl: async () => [
        candidate({
          title: "City publishes a situation report",
          summary: "Officials published a report.",
        }),
      ],
      discoveryProvider: {
        async generateStructured(request) {
          if (request.schemaName === "news_candidate_curation") {
            return {
              value: { rankedCandidateIds: ["candidate-1"] },
              usageEvents: [],
            };
          }
          const fullEvidence = /combat operations/i.test(
            request.input.article.text,
          );
          return {
            value: {
              assessments: [
                {
                  topicCode: "war_conflict",
                  relation: fullEvidence ? "main_subject" : "unrelated",
                },
              ],
            },
            usageEvents: [],
          };
        },
      },
      fetchArticleImpl: async (url) => ({
        text: "Full evidence is about combat operations.",
        contentHash: "transition-replacement-evidence",
        finalUrl: url,
      }),
      retryImpl: (operation) => operation(),
      log: { info() {} },
    }),
    (error) => error === failReplacement,
  );
  assert.equal(failedWith, transitionFailure);
});

test("all evidence blocked by policy is terminal no-candidates and no blocked fallback is selected", async () => {
  const transitions = [];
  let finished;
  let articleSequence = 0;
  const repository = {
    async startSearchRun() { return { id: "run-policy-all-blocked" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(value) {
      articleSequence += 1;
      return { id: `blocked-article-${articleSequence}`, ...value };
    },
    async saveRawContent() {},
    async transitionArticle(...args) { transitions.push(args); },
    async finishSearchRun(_id, details) { finished = details; },
    async failSearchRun() {
      throw new Error("must not fail a policy-filtered terminal run");
    },
  };
  await assert.rejects(
    runResearch({
      repository,
      query: "world news",
      now: NOW,
      newsSettings: {
        languageCode: "en",
        topicCodes: ["ai"],
        customTopics: [],
        excludedTopicCodes: ["war_conflict"],
        version: 9,
      },
      fetchFeedImpl: async () => [
        candidate({
          title: "City releases report one",
          canonicalUrl: "https://example.com/a-report",
          summary: "Officials published a short report.",
          contentHash: "a-report",
        }),
        candidate({
          title: "City releases report two",
          canonicalUrl: "https://example.com/b-report",
          summary: "Officials published another short report.",
          contentHash: "b-report",
        }),
      ],
      discoveryProvider: {
        async generateStructured(request) {
          if (request.schemaName === "news_candidate_curation") {
            return {
              value: {
                rankedCandidateIds: ["candidate-1", "candidate-2"],
              },
              usageEvents: [],
            };
          }
          const isConflictEvidence = /Military combat operations/i.test(
            request.input.article.text,
          );
          return {
            value: {
              assessments: [
                {
                  topicCode: "war_conflict",
                  relation: isConflictEvidence ? "main_subject" : "unrelated",
                },
              ],
            },
            provider: "configured-provider",
            model: "configured-model",
            usageEvents: [],
          };
        },
      },
      fetchArticleImpl: async (url) => ({
        text: `Military combat operations are the main subject of ${url}.`,
        contentHash: `blocked-${url}`,
        finalUrl: url,
      }),
      retryImpl: (operation) => operation(),
    }),
    /excluded-topic policy/,
  );

  assert.equal(finished.resultCount, 0);
  assert.equal(finished.metadata.status, "no_candidates");
  assert.equal(finished.metadata.reason, "excluded_topic_policy");
  assert.equal(finished.metadata.terminal_stage, "selected_evidence");
  assert.equal(
    finished.metadata.excluded_topic_policy.evidence_blocked_count,
    2,
  );
  assert.equal(JSON.stringify(finished.metadata).includes("a-report"), false);
  assert.deepEqual(
    transitions.map((entry) => entry.slice(0, 3)),
    [
      ["blocked-article-1", "discovered", "rejected"],
      ["blocked-article-2", "discovered", "rejected"],
    ],
  );
  assert.ok(
    transitions.every(
      (entry) =>
        entry[3].metadata.excluded_topic_policy.reason ===
          "semantic_main_subject" &&
        entry[3].metadata.excluded_topic_policy.policy_code ===
          "war_conflict",
    ),
  );
});

test("explicit empty exclusions preserve legacy research parity and emit no policy log", async () => {
  const logs = [];
  let finished;
  const repository = {
    async startSearchRun() { return { id: "run-policy-disabled" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(value) {
      return { id: "policy-disabled-article", ...value };
    },
    async saveRawContent() {},
    async finishSearchRun(_id, details) { finished = details; },
    async failSearchRun() {},
  };
  const result = await runResearch({
    repository,
    query: "world news",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: ["ai"],
      customTopics: [],
      excludedTopicCodes: [],
      version: 11,
    },
    fetchFeedImpl: async () => [
      candidate({
        title: "Missile strike kills three civilians in overnight attack",
        canonicalUrl: "https://example.com/legacy-parity",
        contentHash: "legacy-parity",
      }),
    ],
    fetchArticleImpl: async (url) => ({
      text: "Full article evidence.",
      contentHash: "legacy-evidence",
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
    log: { info(value) { logs.push(value); } },
  });

  assert.equal(result.selected.canonicalUrl, "https://example.com/legacy-parity");
  assert.deepEqual(logs, []);
  assert.equal(
    Object.hasOwn(finished.metadata, "excluded_topic_policy"),
    false,
  );
});

test("policy logs contain only sanitized audit fields on classifier failure", async () => {
  const sensitive = "raw-title-url-provider-secret";
  const logs = [];
  let finished;
  const repository = {
    async startSearchRun() { return { id: "run-policy-safe-log" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async finishSearchRun(_id, details) { finished = details; },
    async failSearchRun() {
      throw new Error("must not fail a policy-filtered terminal run");
    },
  };
  await assert.rejects(
    runResearch({
      repository,
      query: "world news",
      now: NOW,
      newsSettings: {
        languageCode: "en",
        topicCodes: ["ai"],
        customTopics: [],
        excludedTopicCodes: ["war_conflict"],
        version: 12,
      },
      fetchFeedImpl: async () => [
        candidate({
          title: `Military developments ${sensitive}`,
          canonicalUrl: `https://${sensitive}.example/article`,
          summary: `Combat reporting ${sensitive}`,
          contentHash: sensitive,
        }),
      ],
      discoveryProvider: {
        async generateStructured() {
          throw new Error(`provider payload ${sensitive}`);
        },
      },
      retryImpl: (operation) => operation(),
      log: { info(value) { logs.push(value); } },
    }),
    /excluded-topic policy/,
  );

  assert.equal(logs.length, 1);
  assert.equal(logs[0].includes(sensitive), false);
  const audit = JSON.parse(logs[0]);
  assert.equal(audit.stage, "discovery");
  assert.deepEqual(audit.policyCodes, ["war_conflict"]);
  assert.equal(audit.semanticBlockedCount, 1);
  assert.equal(audit.promptVersion, "excluded-topics-v1");
  assert.equal(JSON.stringify(finished.metadata).includes(sensitive), false);
});

test("a failing policy logger cannot alter an eligible research decision", async () => {
  const repository = {
    async startSearchRun() { return { id: "run-policy-hostile-log" }; },
    async listEnabledSources() { return [PRIMARY_SOURCE]; },
    async markSourceChecked() {},
    async createOrResumeArticleCandidate(value) {
      return { id: "policy-hostile-log-article", ...value };
    },
    async saveRawContent() {},
    async finishSearchRun() {},
    async failSearchRun() {},
  };
  const result = await runResearch({
    repository,
    query: "science news",
    now: NOW,
    newsSettings: {
      languageCode: "en",
      topicCodes: ["ai"],
      customTopics: [],
      excludedTopicCodes: ["war_conflict"],
      version: 13,
    },
    fetchFeedImpl: async () => [
      candidate({
        title: "Researchers validate a new sensor",
        summary: "The independent result is unrelated to armed conflict.",
      }),
    ],
    discoveryProvider: {
      async generateStructured(request) {
        if (request.schemaName === "news_candidate_curation") {
          return {
            value: { rankedCandidateIds: ["candidate-1"] },
            usageEvents: [],
          };
        }
        return {
          value: {
            assessments: [
              { topicCode: "war_conflict", relation: "unrelated" },
            ],
          },
          provider: "configured-provider",
          model: "configured-model",
          usageEvents: [],
        };
      },
    },
    fetchArticleImpl: async (url) => ({
      text: "Verified sensor evidence unrelated to armed conflict.",
      contentHash: "hostile-log-evidence",
      finalUrl: url,
    }),
    retryImpl: (operation) => operation(),
    log: { info() { throw new Error("logger unavailable"); } },
  });

  assert.equal(result.selected.article.id, "policy-hostile-log-article");
});

// The recency term used to decay at a fixed 0.625 points per hour, which was
// 30/48: it reached zero exactly at the edge of the only window that existed.
// Deriving the slope from the window has to leave that window untouched, or
// this change would silently re-rank production's news as a side effect of
// adding a fresher tier. This is the assertion that keeps the two honest.
const legacyRecency = (ageHours) =>
  Math.max(0, 30 - Math.min(30, ageHours * 0.625));

const plainSource = { id: "s", reliability_score: 50, is_primary: false };

const agedCandidate = (ageHours) => ({
  title: "Untitled",
  canonicalUrl: `https://example.com/${ageHours}`,
  publishedAt: new Date(NOW.valueOf() - ageHours * 60 * 60 * 1000).toISOString(),
});

test("at a 48 hour window the score is identical to the fixed-slope formula", () => {
  for (const ageHours of [0, 0.5, 1, 6, 12, 23.9, 24, 36, 47.9, 48, 60, 96]) {
    assert.equal(
      scoreCandidate(agedCandidate(ageHours), plainSource, {
        now: NOW,
        windowHours: 48,
      }),
      Number((50 * 0.2 + legacyRecency(ageHours)).toFixed(3)),
      `age ${ageHours}h must be scored exactly as before at a 48 hour window`,
    );
  }
});

test("a 24 hour window spends the whole recency range inside that window", () => {
  const at = (ageHours) =>
    scoreCandidate(agedCandidate(ageHours), plainSource, {
      now: NOW,
      windowHours: 24,
    });

  // Base is reliability only: 50 * 0.2.
  assert.equal(at(0), 40, "an article published now takes the full 30 points");
  assert.equal(at(12), 25, "half the window spends half the range");
  assert.equal(at(24), 10, "the edge of the window is worth no recency at all");

  // The point of the change: under the fixed slope a day-old article kept half
  // its freshness score, so the fresh tier could not tell it from a new one.
  assert.equal(
    Number((50 * 0.2 + legacyRecency(24)).toFixed(3)),
    25,
    "the old formula gave a 24-hour-old article the same score as a 12-hour-old one does now",
  );
  assert.ok(
    at(1) - at(23) > 25,
    "an hour-old article must now clearly outrank a nearly-expired one",
  );
});

test("ranking inside a 24 hour window puts the freshest first", () => {
  const ranked = rankCandidates(
    [23, 2, 14, 0.5].map((ageHours) => ({
      ...agedCandidate(ageHours),
      source: plainSource,
    })),
    { now: NOW, windowHours: 24 },
  );

  assert.deepEqual(
    ranked.map((candidate) => candidate.canonicalUrl),
    [
      "https://example.com/0.5",
      "https://example.com/2",
      "https://example.com/14",
      "https://example.com/23",
    ],
  );
});
