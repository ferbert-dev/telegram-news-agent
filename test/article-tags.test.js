import assert from "node:assert/strict";
import test from "node:test";
import {
  appendTopicHashtags,
  normalizeArticleTagging,
  PUBLIC_TOPIC_TAG_CONFIDENCE_THRESHOLD,
  renderTopicHashtags,
  validateArticleTagCatalog,
  validateTopicTagAssignments,
} from "../src/article-tags.js";

const CATALOG = [
  {
    code: "science",
    label: "Science",
    hashtag: { en: "#Science", uk: "#Наука", de: "#Wissenschaft" },
  },
  {
    code: "world_news",
    label: "World news",
    hashtag: "#WorldNews",
    description: "Major international developments",
  },
  {
    code: "nature",
    label: "Nature",
    hashtag: "#Nature",
  },
];

test("article tagging defaults off and safely ignores catalog data", () => {
  assert.deepEqual(normalizeArticleTagging(), { state: "off", catalog: [] });
  assert.deepEqual(
    normalizeArticleTagging({ state: "off", catalog: [{ invalid: true }] }),
    { state: "off", catalog: [] },
  );
  assert.deepEqual(
    validateTopicTagAssignments(
      [{ code: "model-invented", confidence: 1 }],
      { state: "off", catalog: [] },
    ),
    [],
  );
});

test("catalog validation accepts safe stable codes and rejects unsafe entries", () => {
  const catalog = validateArticleTagCatalog([
    ...CATALOG,
    { code: "disabled", label: "Disabled", hashtag: "#Disabled", enabled: false },
  ]);
  assert.deepEqual(catalog.map(({ code }) => code), [
    "science",
    "world_news",
    "nature",
  ]);
  assert.throws(
    () =>
      validateArticleTagCatalog([
        CATALOG[0],
        { ...CATALOG[0], label: "Duplicate" },
      ]),
    /Duplicate article tag code/,
  );
  assert.throws(
    () =>
      validateArticleTagCatalog([
        { code: "Bad Tag", label: "Bad", hashtag: "#Bad" },
      ]),
    /safe lowercase slug/,
  );
  assert.throws(
    () =>
      validateArticleTagCatalog([
        { code: "bad", label: "Bad", hashtag: "#bad-tag" },
      ]),
    /letters, numbers, or underscores/,
  );
});

test("collect and enabled assignments are unique, bounded, and catalog-only", () => {
  const tagging = { state: "collect", catalog: CATALOG };
  assert.deepEqual(
    validateTopicTagAssignments(
      [
        { code: "science", confidence: 0.91 },
        { code: "nature", confidence: 0.65 },
      ],
      tagging,
    ),
    [
      { code: "science", confidence: 0.91 },
      { code: "nature", confidence: 0.65 },
    ],
  );
  assert.throws(
    () =>
      validateTopicTagAssignments(
        [{ code: "invented", confidence: 0.9 }],
        tagging,
      ),
    /not in the enabled catalog/,
  );
  assert.throws(
    () =>
      validateTopicTagAssignments(
        [
          { code: "science", confidence: 0.9 },
          { code: "science", confidence: 0.8 },
        ],
        tagging,
      ),
    /Duplicate topic tag assignment/,
  );
  assert.throws(
    () =>
      validateTopicTagAssignments(
        [{ code: "science", confidence: 1.1 }],
        tagging,
      ),
    /between 0 and 1/,
  );
});

test("public rendering uses localized catalog hashtags above the 0.60 threshold", () => {
  assert.equal(PUBLIC_TOPIC_TAG_CONFIDENCE_THRESHOLD, 0.6);
  const assignments = [
    { code: "nature", confidence: 0.59 },
    { code: "world_news", confidence: 0.8 },
    { code: "science", confidence: 0.95 },
  ];
  assert.equal(
    renderTopicHashtags(assignments, { state: "enabled", catalog: CATALOG }, {
      languageCode: "de",
    }),
    "#Wissenschaft #WorldNews",
  );
  assert.equal(
    renderTopicHashtags(assignments, { state: "collect", catalog: CATALOG }),
    "",
  );
});

test("hashtag appending is final and idempotent", () => {
  const tagging = { state: "enabled", catalog: CATALOG };
  const assignments = [{ code: "science", confidence: 0.9 }];
  const once = appendTopicHashtags(
    "Article\n\nSources:\nhttps://example.com",
    assignments,
    tagging,
  );
  assert.equal(
    once,
    "Article\n\nSources:\nhttps://example.com\n\n#Science",
  );
  assert.equal(appendTopicHashtags(once, assignments, tagging), once);
});
