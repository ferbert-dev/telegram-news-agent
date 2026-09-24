import assert from "node:assert/strict";
import test, { mock } from "node:test";

/**
 * Legacy against typed, on shared fixtures.
 *
 * "Port settings and scheduling helpers to TypeScript" added four typed
 * twins (src/settings/domain/{excluded-topics,news-settings}.ts,
 * src/scheduler/domain/quiet-hours.ts, src/operations/domain/pipeline-states.ts)
 * that are meant to be line-for-line ports of the legacy modules they replace
 * in every typed importer. A port that merely "looks right" is not proof --
 * this file imports both sides and runs the same fixtures through each,
 * asserting the outputs (or, for throws, the error class name and message)
 * are identical. Divergence here means the typed twin changed behaviour, not
 * just syntax, and one of these settings governs what gets published, when a
 * scheduled run defers for quiet hours, or which pipeline-state transitions
 * are legal -- CLAUDE.md names quiet hours and idempotent publication among
 * the behaviours that must be preserved across the port.
 *
 * An independent review of the first version of this file ran eleven mutants
 * against the twins; only one (an error-message change) turned this suite
 * red. The rest survived because the fixtures compared only the *returned
 * value*, never (a) whether the result was frozen the way legacy freezes it,
 * (b) the exact request object a classifier receives, or (c) several
 * coercion/precedence rules that only a specific input shape exercises --
 * empty strings, a null camelCase field next to a present snake_case one,
 * numeric-string columns (as a bigint row arrives over the wire), Date/number
 * timestamps, and a classifier whose *returned value* is not a plain object.
 * Every fixture and helper added below exists to close one of those eleven
 * gaps; see the comment next to each for which mutant it catches.
 */

import * as legacyExcludedTopics from "../../src/excluded-topics.js";
import * as typedExcludedTopics from "../../src/settings/domain/excluded-topics.js";
import * as legacyNewsSettings from "../../src/news-settings.js";
import * as typedNewsSettings from "../../src/settings/domain/news-settings.js";
import * as legacyQuietHours from "../../src/quiet-hours.js";
import * as typedQuietHours from "../../src/scheduler/domain/quiet-hours.js";
import * as legacyPipelineStates from "../../src/pipeline-states.js";
import * as typedPipelineStates from "../../src/operations/domain/pipeline-states.js";

type Attempt =
  | { outcome: "returned"; value: unknown }
  | { outcome: "threw"; name: string; message: string };

function attempt(fn: () => unknown): Attempt {
  try {
    return { outcome: "returned", value: fn() };
  } catch (error) {
    return {
      outcome: "threw",
      name: (error as Error).constructor.name,
      message: (error as Error).message,
    };
  }
}

async function attemptAsync(fn: () => Promise<unknown>): Promise<Attempt> {
  try {
    return { outcome: "returned", value: await fn() };
  } catch (error) {
    return {
      outcome: "threw",
      name: (error as Error).constructor.name,
      message: (error as Error).message,
    };
  }
}

function assertSame(name: string, legacy: Attempt, typed: Attempt): void {
  assert.deepEqual(typed, legacy, name);
}

/**
 * A deep, order-independent snapshot of which nodes of a value are frozen.
 *
 * `assert.deepEqual`/`deepStrictEqual` compare enumerable own properties and
 * never look at `Object.isFrozen` -- two objects with identical fields but
 * different mutability compare equal. Legacy freezes the top-level result of
 * `normalizeNewsSettings` and, individually, its `topicCodes`/`customTopics`/
 * `excludedTopicCodes` arrays (`src/news-settings.js` around the final
 * `Object.freeze({...})`), plus every exported constant object down to its
 * nested fields (`Object.freeze` on `LANGUAGE_OPTIONS`, each entry inside it,
 * `TOPIC_PRESETS`, `EXCLUDED_TOPIC_TAXONOMY`, etc.). It deliberately does NOT
 * freeze `newsSettingsSnapshot`'s or `buildSearchPlan`'s return values -- both
 * build plain object/array literals. This walks a value recursively and
 * records `Object.isFrozen` at every array/object node so a twin that drops a
 * freeze (or adds one legacy doesn't have) shows up as a shape difference.
 */
function frozenShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return { frozen: Object.isFrozen(value), items: value.map(frozenShape) };
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, frozenShape(record[key])] as const),
    );
    return { frozen: Object.isFrozen(value), fields };
  }
  return { leaf: value };
}

function assertFrozenParity(name: string, legacyValue: unknown, typedValue: unknown): void {
  assert.deepEqual(
    frozenShape(typedValue),
    frozenShape(legacyValue),
    `${name}: frozen-ness must match, deeply, including nested arrays and objects`,
  );
}

// ---------------------------------------------------------------------------
// Exported constants -- every one, byte for byte, and frozen exactly alike.
// ---------------------------------------------------------------------------

test("every exported constant matches between legacy and typed news-settings", () => {
  assert.deepEqual(typedNewsSettings.LANGUAGE_OPTIONS, legacyNewsSettings.LANGUAGE_OPTIONS);
  assert.deepEqual(typedNewsSettings.TOPIC_PRESETS, legacyNewsSettings.TOPIC_PRESETS);
  assert.deepEqual(typedNewsSettings.DEFAULT_TOPIC_CODES, legacyNewsSettings.DEFAULT_TOPIC_CODES);
  assert.deepEqual(
    typedNewsSettings.SCHEDULE_INTERVAL_MINUTES,
    legacyNewsSettings.SCHEDULE_INTERVAL_MINUTES,
  );
  assert.deepEqual(
    typedNewsSettings.DEFAULT_EXCLUDED_TOPIC_CODES,
    legacyNewsSettings.DEFAULT_EXCLUDED_TOPIC_CODES,
  );
});

test("every exported constant matches between legacy and typed excluded-topics", () => {
  assert.deepEqual(
    typedExcludedTopics.EXCLUDED_TOPIC_TAXONOMY,
    legacyExcludedTopics.EXCLUDED_TOPIC_TAXONOMY,
  );
  assert.deepEqual(
    typedExcludedTopics.DEFAULT_EXCLUDED_TOPIC_CODES,
    legacyExcludedTopics.DEFAULT_EXCLUDED_TOPIC_CODES,
  );
  assert.deepEqual(
    typedExcludedTopics.EXCLUDED_TOPIC_RELATIONS,
    legacyExcludedTopics.EXCLUDED_TOPIC_RELATIONS,
  );
});

test("every exported constant matches between legacy and typed quiet-hours", () => {
  assert.equal(typedQuietHours.NEWS_SCHEDULE_TIME_ZONE, legacyQuietHours.NEWS_SCHEDULE_TIME_ZONE);
  assert.equal(typedQuietHours.QUIET_HOURS_START, legacyQuietHours.QUIET_HOURS_START);
  assert.equal(typedQuietHours.QUIET_HOURS_END, legacyQuietHours.QUIET_HOURS_END);
  assert.equal(typedQuietHours.QUIET_HOURS_LABEL, legacyQuietHours.QUIET_HOURS_LABEL);
});

test("every exported constant has matching frozen-ness, deeply (mutant: drop a nested Object.freeze)", () => {
  assertFrozenParity("LANGUAGE_OPTIONS", legacyNewsSettings.LANGUAGE_OPTIONS, typedNewsSettings.LANGUAGE_OPTIONS);
  assertFrozenParity("TOPIC_PRESETS", legacyNewsSettings.TOPIC_PRESETS, typedNewsSettings.TOPIC_PRESETS);
  assertFrozenParity(
    "DEFAULT_TOPIC_CODES",
    legacyNewsSettings.DEFAULT_TOPIC_CODES,
    typedNewsSettings.DEFAULT_TOPIC_CODES,
  );
  assertFrozenParity(
    "SCHEDULE_INTERVAL_MINUTES",
    legacyNewsSettings.SCHEDULE_INTERVAL_MINUTES,
    typedNewsSettings.SCHEDULE_INTERVAL_MINUTES,
  );
  assertFrozenParity(
    "EXCLUDED_TOPIC_TAXONOMY",
    legacyExcludedTopics.EXCLUDED_TOPIC_TAXONOMY,
    typedExcludedTopics.EXCLUDED_TOPIC_TAXONOMY,
  );
  assertFrozenParity(
    "DEFAULT_EXCLUDED_TOPIC_CODES",
    legacyExcludedTopics.DEFAULT_EXCLUDED_TOPIC_CODES,
    typedExcludedTopics.DEFAULT_EXCLUDED_TOPIC_CODES,
  );
  assertFrozenParity(
    "EXCLUDED_TOPIC_RELATIONS",
    legacyExcludedTopics.EXCLUDED_TOPIC_RELATIONS,
    typedExcludedTopics.EXCLUDED_TOPIC_RELATIONS,
  );
});

// ---------------------------------------------------------------------------
// normalizeNewsSettings -- undefined/empty/partial/invalid/full/edge rows.
// ---------------------------------------------------------------------------

const NEWS_SETTINGS_ROWS: Array<[string, unknown]> = [
  ["undefined row", undefined],
  ["empty row", {}],
  ["partial row: channelId only", { channelId: "@channel" }],
  [
    "partial row: legacy channel_id fallback quirk (no channelId/telegram_channel_id)",
    { channel_id: "legacy-channel" },
  ],
  [
    "partial row: legacy control_chat_id fallback quirk (no reviewChatId/review_chat_id)",
    { control_chat_id: 77 },
  ],
  ["invalid languageCode", { languageCode: "fr" }],
  ["invalid topicCodes: not an array", { topicCodes: "ai" }],
  ["invalid topicCodes: unknown code", { topicCodes: ["not-a-real-topic"] }],
  // Mutant: remove `.trim()` from the topicCodes map. Without it, "  ai  "
  // stays "  ai  " (not a known preset) and this throws "Unknown topic code"
  // on the mutated side while legacy trims it down to "ai" and succeeds.
  [
    "topicCodes are trimmed and case-folded before dedup and validation",
    { topicCodes: ["  ai  ", "AI", " Ai"] },
  ],
  ["invalid customTopics: not an array", { customTopics: "one topic" }],
  ["invalid customTopics: too short", { customTopics: ["a"] }],
  ["invalid customTopics: too long", { customTopics: ["x".repeat(81)] }],
  ["invalid customTopics: contains URL", { customTopics: ["see https://example.test"] }],
  ["invalid customTopics: disallowed characters", { customTopics: ["<script>"] }],
  ["custom topic normalizes internal whitespace", { customTopics: ["  Deep   sea   life  "] }],
  ["no topics selected at all", { topicCodes: [], customTopics: [] }],
  [
    "too many topics total (13)",
    {
      topicCodes: [...legacyNewsSettings.DEFAULT_TOPIC_CODES],
      customTopics: ["Alpha topic", "Beta topic", "Gamma topic", "Delta topic"],
    },
  ],
  [
    "too many custom topics (6)",
    {
      topicCodes: [],
      customTopics: ["One", "Two", "Three", "Four", "Five", "Six"],
    },
  ],
  ["invalid excludedTopicCodes: unknown code", { excludedTopicCodes: ["not_a_real_code"] }],
  ["invalid excludedTopicCodes: not an array", { excludedTopicCodes: "war_conflict" }],
  ["invalid scheduleIntervalMinutes", { scheduleIntervalMinutes: 45 }],
  ["null scheduleIntervalMinutes stays null", { scheduleIntervalMinutes: null }],
  ["invalid approvalPolicy", { approvalPolicy: "auto" }],
  ["invalid quietHoursEnabled type", { quietHoursEnabled: "yes" }],
  ["invalid version: zero", { version: 0 }],
  ["invalid version: fractional", { version: 1.5 }],
  ["invalid nextRunAt", { nextRunAt: "not-a-timestamp" }],
  ["valid nextRunAt", { nextRunAt: "2026-01-15T10:00:00.000Z" }],
  ["invalid channelId type", { channelId: { nested: true } }],
  ["invalid updatedBy type", { updatedBy: [] }],
  // Mutant: drop `|| value === ""` from normalizeNullableId (~news-settings.ts
  // line 146). An empty string is a valid `string`, so without that clause
  // the mutated twin would return "" instead of coercing to null.
  [
    "empty strings coerce to null via normalizeNullableId (channelId, reviewChatId, updatedBy)",
    { channelId: "", reviewChatId: "", updatedBy: "" },
  ],
  // Mutant: drop `|| intervalValue === ""` from the scheduleIntervalMinutes
  // branch (~line 230). Number("") is 0, which is not one of the allowed
  // intervals, so a stripped clause would throw instead of yielding null.
  ["empty string scheduleIntervalMinutes coerces to null", { scheduleIntervalMinutes: "" }],
  // Mutant: drop `&& nextRunValue !== ""` from the nextRunAt branch (~line
  // 266). `new Date("")` is Invalid Date, so a stripped clause would throw
  // "nextRunAt must be a valid timestamp" instead of yielding null.
  ["empty string nextRunAt coerces to null", { nextRunAt: "" }],
  // Mutant: change `row[camelName] !== undefined` to something that also
  // treats an explicit `null` as absent (e.g. `!= null`). Legacy's
  // `firstDefined` only falls through to the snake_case key when the
  // camelCase key is literally `undefined` -- a present `null` wins and is
  // NOT overridden by a present snake_case value.
  [
    "explicit null channelId wins over a present telegram_channel_id",
    { channelId: null, telegram_channel_id: "@should-not-be-used" },
  ],
  [
    "explicit null reviewChatId wins over a present review_chat_id",
    { reviewChatId: null, review_chat_id: "should-not-be-used" },
  ],
  [
    "explicit null updatedBy wins over a present updated_by",
    { updatedBy: null, updated_by: "should-not-be-used" },
  ],
  [
    "explicit null scheduleIntervalMinutes wins over a present schedule_interval_minutes",
    { scheduleIntervalMinutes: null, schedule_interval_minutes: 180 },
  ],
  [
    "explicit null nextRunAt wins over a present next_run_at",
    { nextRunAt: null, next_run_at: "2026-01-01T00:00:00.000Z" },
  ],
  [
    "explicit null languageCode wins over a present language_code, and null still fails validation",
    { languageCode: null, language_code: "uk" },
  ],
  [
    "explicit null approvalPolicy wins over a present approval_policy, and null still fails validation",
    { approvalPolicy: null, approval_policy: "automatic" },
  ],
  [
    "explicit null quietHoursEnabled wins over a present quiet_hours_enabled, and null still fails validation",
    { quietHoursEnabled: null, quiet_hours_enabled: true },
  ],
  // Bigint-typed PostgreSQL columns (schedule_interval_minutes, version)
  // arrive over `pg` as strings; Number(...) must still coerce them.
  ["numeric-string version, as a bigint row column would arrive", { version: "5" }],
  [
    "numeric-string scheduleIntervalMinutes, as a bigint row column would arrive",
    { scheduleIntervalMinutes: "360" },
  ],
  ["nextRunAt as a Date instance", { nextRunAt: new Date("2026-05-01T06:00:00.000Z") }],
  ["nextRunAt as an epoch-millisecond number", { nextRunAt: 1_777_000_000_000 }],
  [
    "full valid row, camelCase",
    {
      channelId: "@channel",
      reviewChatId: 42,
      scheduleIntervalMinutes: 360,
      languageCode: "DE",
      topicCodes: ["ai", "AI", "science"],
      customTopics: ["Deep sea life"],
      excludedTopicCodes: ["war_conflict"],
      approvalPolicy: "AUTOMATIC",
      quietHoursEnabled: false,
      nextRunAt: "2026-02-01T08:30:00.000Z",
      version: 7,
      updatedBy: "operator-1",
    },
  ],
  [
    "full valid row, snake_case",
    {
      telegram_channel_id: "@snake-channel",
      review_chat_id: "snake-chat",
      schedule_interval_minutes: 1440,
      language_code: "uk",
      topic_codes: ["nature", "history"],
      custom_topics: ["Marine biology"],
      excluded_topic_codes: ["war_conflict"],
      approval_policy: "manual",
      quiet_hours_enabled: true,
      next_run_at: "2026-03-01T00:00:00.000Z",
      version: 2,
      updated_by: 9,
    },
  ],
];

test("normalizeNewsSettings matches between legacy and typed across every fixture", () => {
  for (const [name, row] of NEWS_SETTINGS_ROWS) {
    const legacy = attempt(() => legacyNewsSettings.normalizeNewsSettings(row as never));
    const typed = attempt(() => typedNewsSettings.normalizeNewsSettings(row as never));
    assertSame(`normalizeNewsSettings: ${name}`, legacy, typed);
  }
});

test("normalizeNewsSettings freezes exactly what legacy freezes, deeply (mutant: drop the result or array Object.freeze)", () => {
  const fixtures: Array<[string, unknown]> = [
    ["empty row", {}],
    [
      "full valid row",
      {
        channelId: "@channel",
        topicCodes: ["ai", "science"],
        customTopics: ["Deep sea life"],
        excludedTopicCodes: ["war_conflict"],
      },
    ],
  ];
  for (const [name, row] of fixtures) {
    const legacy = legacyNewsSettings.normalizeNewsSettings(row as never);
    const typed = typedNewsSettings.normalizeNewsSettings(row as never);
    assertFrozenParity(`normalizeNewsSettings: ${name}`, legacy, typed);
  }
});

// ---------------------------------------------------------------------------
// newsSettingsSnapshot
// ---------------------------------------------------------------------------

const SNAPSHOT_ROWS: Array<[string, unknown]> = [
  ["default row", {}],
  [
    "full row",
    {
      channelId: "@channel",
      reviewChatId: 42,
      scheduleIntervalMinutes: 180,
      languageCode: "uk",
      topicCodes: ["ai", "world"],
      customTopics: ["Marine biology"],
      excludedTopicCodes: ["war_conflict"],
      approvalPolicy: "automatic",
      quietHoursEnabled: true,
      nextRunAt: "2026-04-01T12:00:00.000Z",
      version: 3,
      updatedBy: "operator-2",
    },
  ],
  ["invalid row", { languageCode: "xx" }],
];

test("newsSettingsSnapshot matches between legacy and typed across every fixture", () => {
  for (const [name, row] of SNAPSHOT_ROWS) {
    const legacy = attempt(() => legacyNewsSettings.newsSettingsSnapshot(row as never));
    const typed = attempt(() => typedNewsSettings.newsSettingsSnapshot(row as never));
    assertSame(`newsSettingsSnapshot: ${name}`, legacy, typed);
  }
});

test("newsSettingsSnapshot and buildSearchPlan are unfrozen on both sides (only normalizeNewsSettings freezes)", () => {
  const snapshotLegacy = legacyNewsSettings.newsSettingsSnapshot({} as never);
  const snapshotTyped = typedNewsSettings.newsSettingsSnapshot({} as never);
  assertFrozenParity("newsSettingsSnapshot({})", snapshotLegacy, snapshotTyped);

  const planLegacy = legacyNewsSettings.buildSearchPlan({} as never);
  const planTyped = typedNewsSettings.buildSearchPlan({} as never);
  assertFrozenParity("buildSearchPlan({})", planLegacy, planTyped);
});

// ---------------------------------------------------------------------------
// buildSearchPlan
// ---------------------------------------------------------------------------

const SEARCH_PLAN_ROWS: Array<[string, unknown]> = [
  ["default settings", {}],
  ["single preset topic, English", { topicCodes: ["ai"], languageCode: "en" }],
  [
    "multiple presets and custom topics, Ukrainian",
    {
      topicCodes: ["science", "nature", "animals"],
      customTopics: ["Deep sea life", "Volcanology"],
      languageCode: "uk",
    },
  ],
  [
    "custom topics only, German",
    { topicCodes: [], customTopics: ["Raumfahrt"], languageCode: "de" },
  ],
];

test("buildSearchPlan matches between legacy and typed across every fixture", () => {
  for (const [name, row] of SEARCH_PLAN_ROWS) {
    const legacy = attempt(() => legacyNewsSettings.buildSearchPlan(row as never));
    const typed = attempt(() => typedNewsSettings.buildSearchPlan(row as never));
    assertSame(`buildSearchPlan: ${name}`, legacy, typed);
  }
});

// ---------------------------------------------------------------------------
// validateCustomTopic
// ---------------------------------------------------------------------------

const CUSTOM_TOPIC_VALUES: Array<[string, unknown]> = [
  ["valid simple topic", "Marine biology"],
  ["valid topic with punctuation", "AI & robotics (2026)"],
  ["valid topic normalizes internal whitespace", "  Deep   sea   life  "],
  ["too short", "a"],
  ["too long", "x".repeat(81)],
  ["exactly minimum length", "ab"],
  ["exactly maximum length", "x".repeat(80)],
  ["disallowed characters", "topic; DROP TABLE"],
  ["contains URL (https)", "see https://example.test for more"],
  ["contains URL (www)", "visit www.example.test"],
  ["not a string: number", 42],
  ["not a string: null", null],
  ["whitespace only", "   "],
];

test("validateCustomTopic matches between legacy and typed across every fixture", () => {
  for (const [name, value] of CUSTOM_TOPIC_VALUES) {
    const legacy = attempt(() => legacyNewsSettings.validateCustomTopic(value as never));
    const typed = attempt(() => typedNewsSettings.validateCustomTopic(value as never));
    assertSame(`validateCustomTopic: ${name}`, legacy, typed);
  }
});

// ---------------------------------------------------------------------------
// normalizeExcludedTopicCodes and evaluateExcludedTopics
// ---------------------------------------------------------------------------

const EXCLUDED_TOPIC_CODE_VALUES: Array<[string, unknown]> = [
  ["default (undefined)", undefined],
  ["empty array", []],
  ["known code", ["war_conflict"]],
  ["known code, mixed case and whitespace", [" War_Conflict "]],
  ["duplicate known codes collapse", ["war_conflict", "war_conflict"]],
  ["unknown code", ["not_a_real_code"]],
  ["not an array", "war_conflict"],
  ["array with non-string entries", [123, null]],
];

test("normalizeExcludedTopicCodes matches between legacy and typed across every fixture", () => {
  for (const [name, value] of EXCLUDED_TOPIC_CODE_VALUES) {
    const legacy = attempt(() => legacyExcludedTopics.normalizeExcludedTopicCodes(value as never));
    const typed = attempt(() => typedExcludedTopics.normalizeExcludedTopicCodes(value as never));
    assertSame(`normalizeExcludedTopicCodes: ${name}`, legacy, typed);
  }
});

const ARTICLE = Object.freeze({ id: "article-1", title: "Test article" });

type ClassifyBehavior =
  | "none"
  | "returns"
  | "returnsNull"
  | "throws"
  | "rejects"
  | "functionWithAssessments";

type EvaluateScenario = {
  name: string;
  excludedTopicCodes?: unknown;
  classify?: ClassifyBehavior;
  returns?: unknown;
};

/**
 * Builds a fresh classifier function from a declarative scenario, so legacy
 * and typed each get their OWN function instance to wrap with a call-capturing
 * spy -- sharing one instance/spy across both sides would only prove the
 * function object is the same, not that both callers invoke it identically.
 */
function buildClassifier(scenario: EvaluateScenario): ((request: unknown) => unknown) | undefined {
  switch (scenario.classify) {
    case undefined:
    case "none":
      return undefined;
    case "returns":
      return () => scenario.returns;
    case "returnsNull":
      // Mutant: legacy's guard is `!value || !Array.isArray(value.assessments)`.
      // `!null` is true, so this already falls back to uncertain on both
      // sides -- kept as an explicit fixture per the review request rather
      // than assumed.
      return () => null;
    case "throws":
      return () => {
        throw new Error("provider unavailable");
      };
    case "rejects":
      return () => Promise.reject(new Error("provider rejected"));
    case "functionWithAssessments": {
      // Mutant: the twin's `normalizeAssessments` guard used to be
      // `typeof value === "object"`, which excludes functions. Legacy's
      // actual guard, `!value || !Array.isArray(value.assessments)`, is
      // truthy for a function and reads `.assessments` straight off it --
      // JavaScript lets a function carry arbitrary properties. Returning a
      // function value here (not throwing it, not calling it) is exactly
      // that case.
      const resultFn = function classifierResult() {
        throw new Error("this function is a data value, not meant to be called");
      };
      (resultFn as unknown as { assessments: unknown }).assessments = [
        { topicCode: "war_conflict", relation: "main_subject" },
      ];
      return () => resultFn;
    }
  }
}

const EVALUATE_SCENARIOS: EvaluateScenario[] = [
  { name: "no classifier: falls back to uncertain for every topic" },
  {
    name: "no excluded topics configured: returns empty array",
    excludedTopicCodes: [],
  },
  {
    name: "classifier returns a structurally valid, fully unrelated assessment",
    classify: "returns",
    returns: { assessments: [{ topicCode: "war_conflict", relation: "unrelated" }] },
  },
  {
    name: "classifier returns a structurally valid main_subject assessment",
    classify: "returns",
    returns: { assessments: [{ topicCode: "war_conflict", relation: "main_subject" }] },
  },
  {
    name: "classifier response is missing an assessment: falls back to uncertain",
    classify: "returns",
    returns: { assessments: [] },
  },
  {
    name: "classifier response has an unknown relation: falls back to uncertain",
    classify: "returns",
    returns: { assessments: [{ topicCode: "war_conflict", relation: "not_a_real_relation" }] },
  },
  {
    name: "classifier response is not an object with assessments: falls back to uncertain",
    classify: "returns",
    returns: { notAssessments: true },
  },
  {
    // Mutant: remove `.trim().toLowerCase()` from either the assessment's
    // topicCode (canonicalCode) or relation. Whitespace/case here must be
    // normalized away for the assessment to remain structurally valid and
    // resolve to "main_subject" -- a stripped normalization leaves it
    // structurally invalid, which falls back to "uncertain" instead.
    name: "classifier response has whitespace/mixed-case topicCode and relation that must be trimmed and lowercased",
    classify: "returns",
    returns: { assessments: [{ topicCode: "  War_Conflict  ", relation: "  Main_Subject  " }] },
  },
  {
    name: "classifier throws synchronously: fails closed to uncertain",
    classify: "throws",
  },
  {
    name: "classifier returns a rejected promise: fails closed to uncertain",
    classify: "rejects",
  },
  {
    name: "classifier returns null: falls back to uncertain",
    classify: "returnsNull",
  },
  {
    name: "classifier result is a function carrying .assessments: read through it, not typeof-gated",
    classify: "functionWithAssessments",
  },
];

test("evaluateExcludedTopics matches between legacy and typed across every fixture, including the exact classifier request each side sends", async () => {
  for (const scenario of EVALUATE_SCENARIOS) {
    const legacyBehavior = buildClassifier(scenario);
    const typedBehavior = buildClassifier(scenario);
    const legacyCalls: unknown[] = [];
    const typedCalls: unknown[] = [];

    const legacyClassify = legacyBehavior
      ? (request: unknown) => {
          legacyCalls.push(request);
          return legacyBehavior(request);
        }
      : undefined;
    const typedClassify = typedBehavior
      ? (request: unknown) => {
          typedCalls.push(request);
          return typedBehavior(request);
        }
      : undefined;

    const legacy = await attemptAsync(() =>
      legacyExcludedTopics.evaluateExcludedTopics({
        article: ARTICLE,
        excludedTopicCodes: scenario.excludedTopicCodes,
        classify: legacyClassify,
      } as never),
    );
    const typed = await attemptAsync(() =>
      typedExcludedTopics.evaluateExcludedTopics({
        article: ARTICLE,
        excludedTopicCodes: scenario.excludedTopicCodes,
        classify: typedClassify,
      } as never),
    );

    assertSame(`evaluateExcludedTopics: ${scenario.name}`, legacy, typed);
    // Not just the result: the request (article, topicCodes, taxonomy,
    // relations) handed to the classifier must be identical too. A twin that
    // e.g. forgot to clone `topicCodes` before mutating it, or built taxonomy
    // from an unsorted iteration, would still often produce the same final
    // *result* here while handing the classifier a different request.
    assert.deepEqual(
      typedCalls,
      legacyCalls,
      `evaluateExcludedTopics: ${scenario.name} -- the classifier must receive an identical request on both sides`,
    );
  }
});

// ---------------------------------------------------------------------------
// isQuietHoursAt / shouldDeferScheduledNews
// ---------------------------------------------------------------------------

/**
 * Resolves a Europe/Madrid wall-clock time to its UTC instant without
 * hardcoding the CET/CEST offset -- Madrid only ever runs at UTC+1 or UTC+2,
 * so this tries both and keeps whichever one the IANA database (via `Intl`)
 * confirms actually formats back to the requested local time. That makes the
 * DST-transition fixtures self-verifying instead of depending on getting the
 * offset arithmetic right by hand.
 */
function madridInstant(isoDate: string, hour: number, minute: number): Date {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const pad = (value: number) => String(value).padStart(2, "0");
  const wallClockAsUtc = new Date(`${isoDate}T${pad(hour)}:${pad(minute)}:00.000Z`);

  for (const offsetHours of [1, 2]) {
    const candidate = new Date(wallClockAsUtc.getTime() - offsetHours * 3_600_000);
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    const formatted = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    const expected = `${isoDate}T${pad(hour)}:${pad(minute)}`;
    if (formatted === expected) {
      return candidate;
    }
  }
  throw new Error(`Could not resolve Madrid instant for ${isoDate} ${hour}:${minute}`);
}

const DST_DATES = ["2026-03-29", "2026-10-25"];
const QUIET_HOURS_TIMES: Array<[number, number]> = [
  [21, 59],
  [22, 0],
  [7, 59],
  [8, 0],
];

test("isQuietHoursAt matches between legacy and typed at every boundary time, on both 2026 DST transition days", () => {
  for (const date of DST_DATES) {
    for (const [hour, minute] of QUIET_HOURS_TIMES) {
      const instant = madridInstant(date, hour, minute);
      const legacy = attempt(() => legacyQuietHours.isQuietHoursAt(instant as never));
      const typed = attempt(() => typedQuietHours.isQuietHoursAt(instant as never));
      assertSame(`isQuietHoursAt: ${date} ${hour}:${String(minute).padStart(2, "0")}`, legacy, typed);
    }
  }
});

test("isQuietHoursAt matches between legacy and typed for invalid input", () => {
  const legacy = attempt(() => legacyQuietHours.isQuietHoursAt("not-a-timestamp" as never));
  const typed = attempt(() => typedQuietHours.isQuietHoursAt("not-a-timestamp" as never));
  assertSame("isQuietHoursAt: invalid timestamp", legacy, typed);
});

test("isQuietHoursAt matches between legacy and typed for explicit string and number timestamps", () => {
  const insideIso = "2026-06-15T23:30:00.000Z"; // 01:30 Madrid (CEST), inside quiet hours
  const outsideIso = "2026-06-15T12:00:00.000Z"; // 14:00 Madrid (CEST), outside quiet hours
  const fixtures: Array<[string, string | number]> = [
    ["ISO string inside quiet hours", insideIso],
    ["ISO string outside quiet hours", outsideIso],
    ["epoch-millisecond number inside quiet hours", Date.parse(insideIso)],
    ["epoch-millisecond number outside quiet hours", Date.parse(outsideIso)],
  ];
  for (const [name, value] of fixtures) {
    const legacy = attempt(() => legacyQuietHours.isQuietHoursAt(value as never));
    const typed = attempt(() => typedQuietHours.isQuietHoursAt(value as never));
    assertSame(`isQuietHoursAt: ${name}`, legacy, typed);
  }
});

test("isQuietHoursAt matches between legacy and typed with no argument, under a frozen clock", () => {
  // Both sides default their parameter to `new Date()`, evaluated at call
  // time -- not injectable as a plain argument. node:test's built-in timer
  // mock freezes what a zero-argument `new Date()` returns without touching
  // `new Date(arg)` (which every other fixture in this file relies on), so
  // this is scoped tightly and always reset, even on failure.
  const fixtures: Array<[string, string]> = [
    ["frozen clock inside quiet hours", "2026-06-15T23:30:00.000Z"],
    ["frozen clock outside quiet hours", "2026-06-15T12:00:00.000Z"],
  ];
  for (const [name, iso] of fixtures) {
    mock.timers.enable({ apis: ["Date"], now: Date.parse(iso) });
    try {
      const legacy = attempt(() => legacyQuietHours.isQuietHoursAt());
      const typed = attempt(() => typedQuietHours.isQuietHoursAt());
      assertSame(`isQuietHoursAt: no argument, ${name}`, legacy, typed);
    } finally {
      mock.timers.reset();
    }
  }
});

test("shouldDeferScheduledNews matches between legacy and typed at every boundary time, on both 2026 DST transition days", () => {
  for (const date of DST_DATES) {
    for (const [hour, minute] of QUIET_HOURS_TIMES) {
      const instant = madridInstant(date, hour, minute);
      for (const quietHoursEnabled of [true, false]) {
        const settings = { quietHoursEnabled };
        const legacy = attempt(() =>
          legacyQuietHours.shouldDeferScheduledNews(settings as never, instant as never),
        );
        const typed = attempt(() =>
          typedQuietHours.shouldDeferScheduledNews(settings as never, instant as never),
        );
        assertSame(
          `shouldDeferScheduledNews: ${date} ${hour}:${String(minute).padStart(2, "0")} enabled=${quietHoursEnabled}`,
          legacy,
          typed,
        );
      }
    }
  }
});

test("shouldDeferScheduledNews matches between legacy and typed when settings are missing quietHoursEnabled", () => {
  const instant = madridInstant("2026-06-15", 23, 0);
  const legacy = attempt(() => legacyQuietHours.shouldDeferScheduledNews(null as never, instant as never));
  const typed = attempt(() => typedQuietHours.shouldDeferScheduledNews(null as never, instant as never));
  assertSame("shouldDeferScheduledNews: null settings", legacy, typed);
});

// ---------------------------------------------------------------------------
// assertTransition -- every entity, every from/to pair, including invalid.
// ---------------------------------------------------------------------------

const TRANSITION_STATES: Record<string, string[]> = {
  searchRun: ["running", "completed", "failed"],
  article: [
    "discovered",
    "extracted",
    "reviewed",
    "drafted",
    "approved",
    "published",
    "rejected",
    "failed",
  ],
  draft: ["draft", "review", "approved", "publishing", "published", "rejected"],
};

test("assertTransition matches between legacy and typed for every from/to pair of every known entity", () => {
  for (const [entity, states] of Object.entries(TRANSITION_STATES)) {
    for (const from of states) {
      for (const to of states) {
        const legacy = attempt(() =>
          legacyPipelineStates.assertTransition(entity as never, from as never, to as never),
        );
        const typed = attempt(() =>
          typedPipelineStates.assertTransition(entity as never, from as never, to as never),
        );
        assertSame(`assertTransition: ${entity} ${from} -> ${to}`, legacy, typed);
      }
    }
  }
});

test("assertTransition matches between legacy and typed for unknown entities and unknown states", () => {
  const fixtures: Array<[string, string, string, string]> = [
    ["unknown entity", "not-a-real-entity", "draft", "review"],
    ["unknown from state", "draft", "not-a-real-state", "review"],
    ["unknown to state is simply an invalid transition", "draft", "draft", "not-a-real-state"],
    ["searchRun: running -> completed is valid", "searchRun", "running", "completed"],
    ["searchRun: completed -> running is invalid (terminal)", "searchRun", "completed", "running"],
  ];
  for (const [name, entity, from, to] of fixtures) {
    const legacy = attempt(() =>
      legacyPipelineStates.assertTransition(entity as never, from as never, to as never),
    );
    const typed = attempt(() =>
      typedPipelineStates.assertTransition(entity as never, from as never, to as never),
    );
    assertSame(`assertTransition: ${name}`, legacy, typed);
  }
});
