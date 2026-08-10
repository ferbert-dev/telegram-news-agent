import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateStoryDuplicate,
  shortlistPublishedStories,
  storyFingerprint,
  storySimilarity,
  storyTokens,
} from "../src/story-deduplication.js";

const PRIOR = {
  article_id: "published-kimi",
  title: "Kimi AI model escaped cybersecurity testing",
  feed_summary:
    "Researchers reported that a Kimi model tried to bypass its test harness.",
  message_text:
    "A Kimi model attempted to escape a controlled cybersecurity evaluation.",
  telegram_channel_id: "@HonestAINews",
  telegram_message_id: 37,
  published_at: "2026-08-07T08:00:00.000Z",
  story_fingerprint: null,
};

test("story tokens normalize HTML and inflection while fingerprints preserve event order", () => {
  assert.deepEqual(
    [...storyTokens("<b>Models escaped tests</b>")].sort(),
    ["escap", "model", "test"],
  );
  assert.notEqual(
    storyFingerprint({ title: "Alice sues Bob" }),
    storyFingerprint({ title: "Bob sues Alice" }),
  );
  assert.equal(
    storyFingerprint({
      title: "Models escaped tests",
      summary: "The Kimi test happened on Monday.",
    }),
    storyFingerprint({
      title: "  Models escaped tests! ",
      summary: "The Kimi test happened on Monday",
    }),
  );
});

test("similarity shortlists related event coverage but ignores an unrelated topic", () => {
  const related = {
    title: "AI models can escape test environments",
    summary: "A new report reviews attempts to bypass evaluation harnesses.",
  };
  const unrelated = {
    title: "A rare owl population recovers in Germany",
    summary: "Conservationists counted more nesting pairs this year.",
  };
  assert.ok(storySimilarity(related, PRIOR).score >= 0.12);
  assert.equal(shortlistPublishedStories(related, [PRIOR]).length, 1);
  assert.equal(shortlistPublishedStories(unrelated, [PRIOR]).length, 0);
});

test("semantic classifier blocks the same Kimi event across a different publisher", async () => {
  const calls = [];
  const decision = await evaluateStoryDuplicate({
    candidate: {
      title: "AI models can escape test environments",
      summary:
        "A Tech publication describes the same Kimi attempt to bypass a cybersecurity test.",
      publisher: "Different publisher",
      publishedAt: "2026-08-09T08:00:00.000Z",
    },
    publishedStories: [PRIOR],
    aiProvider: {
      async generateStructured(request) {
        calls.push(request);
        return {
          value: {
            relation: "same_story",
            matchedPublishedArticleId: PRIOR.article_id,
            confidence: 0.96,
            reason: "Both describe the same Kimi model escaping its test harness",
          },
          usageEvents: [{ provider: "openai", operation: "story_deduplication" }],
        };
      },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(decision.relation, "duplicate");
  assert.equal(decision.duplicateOfArticleId, PRIOR.article_id);
  assert.equal(decision.decisionSource, "ai");
  assert.equal(decision.classifierAttempted, true);
  assert.equal(decision.usageEvents.length, 1);
});

test("near-identical fingerprint and context are blocked without an AI call", async () => {
  let called = false;
  const decision = await evaluateStoryDuplicate({
    candidate: {
      title: PRIOR.title,
      summary: PRIOR.feed_summary,
    },
    publishedStories: [
      {
        ...PRIOR,
        story_fingerprint: storyFingerprint({
          title: PRIOR.title,
          summary: PRIOR.feed_summary,
        }),
      },
    ],
    aiProvider: {
      async generateStructured() {
        called = true;
        throw new Error("must not be called");
      },
    },
  });
  assert.equal(called, false);
  assert.equal(decision.relation, "duplicate");
  assert.equal(decision.decisionSource, "deterministic");
});

test("a recurring generic headline is semantically checked instead of auto-blocked", async () => {
  let called = false;
  const priorEarthquake = {
    ...PRIOR,
    article_id: "published-earthquake",
    title: "Earthquake strikes Japan",
    feed_summary: "A magnitude 6.1 quake struck Hokkaido on Monday.",
    message_text: "A magnitude 6.1 quake hit northern Japan.",
    story_fingerprint: storyFingerprint({
      title: "Earthquake strikes Japan",
      summary: "A magnitude 6.1 quake struck Hokkaido on Monday.",
    }),
  };
  const nextEarthquake = {
    title: "Earthquake strikes Japan",
    summary: "A magnitude 7.0 quake struck Kyushu two weeks later.",
  };
  assert.notEqual(
    storyFingerprint(nextEarthquake),
    priorEarthquake.story_fingerprint,
  );
  const decision = await evaluateStoryDuplicate({
    candidate: nextEarthquake,
    publishedStories: [priorEarthquake],
    aiProvider: {
      async generateStructured() {
        called = true;
        return {
          value: {
            relation: "distinct",
            matchedPublishedArticleId: null,
            confidence: 0.94,
            reason: "The earthquakes occurred in different regions and times",
          },
          usageEvents: [],
        };
      },
    },
  });
  assert.equal(called, true);
  assert.equal(decision.relation, "distinct");
  assert.equal(decision.decisionSource, "ai");
});

test("legacy Date timestamps can order a multi-story shortlist", () => {
  const newer = { ...PRIOR, article_id: "newer", published_at: new Date("2026-08-08T08:00:00Z") };
  const older = { ...PRIOR, article_id: "older", published_at: new Date("2026-08-07T08:00:00Z") };
  const shortlist = shortlistPublishedStories(
    { title: PRIOR.title, summary: PRIOR.feed_summary },
    [older, newer],
  );
  assert.deepEqual(shortlist.map(({ story }) => story.article_id), ["newer", "older"]);
});

test("invalid structured output fails closed and retains usage evidence", async () => {
  const decision = await evaluateStoryDuplicate({
    candidate: {
      title: "AI models can escape test environments",
      summary: "Researchers examine model escape attempts in controlled tests.",
    },
    publishedStories: [PRIOR],
    aiProvider: {
      async generateStructured() {
        return {
          value: {},
          usageEvents: [{ provider: "openai", operation: "story_deduplication" }],
        };
      },
    },
  });
  assert.equal(decision.relation, "uncertain");
  assert.equal(decision.decisionSource, "fallback");
  assert.equal(decision.classifierAttempted, true);
  assert.equal(decision.usageEvents.length, 1);
});

test("a distinct decision with a matched article fails closed", async () => {
  const decision = await evaluateStoryDuplicate({
    candidate: {
      title: "AI models can escape test environments",
      summary: "Researchers examine model escape attempts in controlled tests.",
    },
    publishedStories: [PRIOR],
    aiProvider: {
      async generateStructured() {
        return {
          value: {
            relation: "distinct",
            matchedPublishedArticleId: PRIOR.article_id,
            confidence: 0.9,
            reason: "Distinct but incorrectly linked",
          },
          usageEvents: [],
        };
      },
    },
  });
  assert.equal(decision.relation, "uncertain");
  assert.equal(decision.duplicateOfArticleId, null);
});

test("a material later outcome remains publishable as a follow-up", async () => {
  const decision = await evaluateStoryDuplicate({
    candidate: {
      title: "Kimi patches escape vulnerability after independent audit",
      summary:
        "The vendor shipped a verified mitigation after the earlier testing incident.",
      publisher: "Primary source",
    },
    publishedStories: [PRIOR],
    aiProvider: {
      async generateStructured() {
        return {
          value: {
            relation: "meaningful_update",
            matchedPublishedArticleId: PRIOR.article_id,
            confidence: 0.91,
            reason: "The verified patch is a new material outcome",
          },
          usageEvents: [],
        };
      },
    },
  });
  assert.equal(decision.relation, "follow_up");
  assert.equal(decision.duplicateOfArticleId, PRIOR.article_id);
});

test("a similar candidate cannot bypass deduplication when the classifier is unavailable", async () => {
  const decision = await evaluateStoryDuplicate({
    candidate: {
      title: "AI models can escape test environments",
      summary: "Researchers examine model escape attempts in controlled tests.",
    },
    publishedStories: [PRIOR],
    aiProvider: null,
  });
  assert.equal(decision.relation, "uncertain");
  assert.equal(decision.decisionSource, "fallback");
  assert.equal(decision.classifierAttempted, false);
});

test("an unrelated event is deterministically distinct without spending AI tokens", async () => {
  let called = false;
  const decision = await evaluateStoryDuplicate({
    candidate: {
      title: "Scientists discover a new deep-sea coral nursery",
      summary: "The habitat was mapped during an Atlantic expedition.",
    },
    publishedStories: [PRIOR],
    aiProvider: {
      async generateStructured() {
        called = true;
        throw new Error("must not be called");
      },
    },
  });
  assert.equal(called, false);
  assert.equal(decision.relation, "distinct");
  assert.equal(decision.decisionSource, "deterministic");
  assert.equal(decision.classifierAttempted, false);
});
