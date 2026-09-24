import assert from "node:assert/strict";
import test from "node:test";

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

// ---------------------------------------------------------------------------
// Exported constants -- every one, byte for byte.
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

type EvaluateScenario = {
  name: string;
  excludedTopicCodes?: unknown;
  classify?: (request: unknown) => unknown;
};

const EVALUATE_SCENARIOS: EvaluateScenario[] = [
  { name: "no classifier: falls back to uncertain for every topic" },
  {
    name: "no excluded topics configured: returns empty array",
    excludedTopicCodes: [],
  },
  {
    name: "classifier returns a structurally valid, fully unrelated assessment",
    classify: () => ({
      assessments: [{ topicCode: "war_conflict", relation: "unrelated" }],
    }),
  },
  {
    name: "classifier returns a structurally valid main_subject assessment",
    classify: () => ({
      assessments: [{ topicCode: "war_conflict", relation: "main_subject" }],
    }),
  },
  {
    name: "classifier response is missing an assessment: falls back to uncertain",
    classify: () => ({ assessments: [] }),
  },
  {
    name: "classifier response has an unknown relation: falls back to uncertain",
    classify: () => ({
      assessments: [{ topicCode: "war_conflict", relation: "not_a_real_relation" }],
    }),
  },
  {
    name: "classifier response is not an object with assessments: falls back to uncertain",
    classify: () => ({ notAssessments: true }),
  },
  {
    name: "classifier throws: fails closed to uncertain",
    classify: () => {
      throw new Error("provider unavailable");
    },
  },
];

test("evaluateExcludedTopics matches between legacy and typed across every fixture", async () => {
  for (const scenario of EVALUATE_SCENARIOS) {
    const input = {
      article: ARTICLE,
      excludedTopicCodes: scenario.excludedTopicCodes,
      classify: scenario.classify,
    };
    const legacy = await attemptAsync(() =>
      legacyExcludedTopics.evaluateExcludedTopics(input as never),
    );
    const typed = await attemptAsync(() =>
      typedExcludedTopics.evaluateExcludedTopics(input as never),
    );
    assertSame(`evaluateExcludedTopics: ${scenario.name}`, legacy, typed);
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
