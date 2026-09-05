import assert from "node:assert/strict";
import test from "node:test";

import { buildSearchPlan } from "../../src/news-settings.js";

import {
  TypedSchedulerNewsWorkflowAdapter,
  buildDraftEvidence,
  type ResearchSelection,
} from "../../src/scheduler/typed-scheduler-news-workflow.adapter.js";
import { buildDraftEvidence as legacyBuildDraftEvidence } from "../../src/pipeline.js";

import type {
  SchedulerNewsWorkflowApplicationPort,
  SchedulerSettingsSnapshot,
} from "../../src/scheduler/scheduler-application.contracts.js";

const settingsSnapshot: SchedulerSettingsSnapshot = {
  channelId: "@channel",
  reviewChatId: 4242,
  scheduleIntervalMinutes: 360,
  languageCode: "en",
  topicCodes: ["ai"],
  customTopics: [],
  excludedTopicCodes: [],
  excludedTopicsProvenance: { source: "news_bot_settings", settingsVersion: 7 },
  approvalPolicy: "manual",
  quietHoursEnabled: true,
  nextRunAt: null,
  version: 7,
  updatedBy: 99,
};

const lease = { name: "news-pipeline", ownerId: "owner-1" };

function selection(overrides: Partial<ResearchSelection> = {}): ResearchSelection {
  return {
    article: { id: "article-1" },
    source: { name: "Example", is_primary: true },
    canonicalUrl: "https://example.com/story",
    title: "A headline",
    publishedAt: "2026-06-26T18:00:00Z",
    evidenceText: "Extracted evidence.",
    ...overrides,
  };
}

function noCandidates(): Error {
  const error = new Error("No recent news candidates were found");
  error.name = "NoResearchCandidatesError";
  return error;
}

function editorialFake(record?: unknown[]) {
  return {
    async generateReviewDraft(input: unknown) {
      record?.push(input);
      return { draft: { id: "draft-1" }, generation: { draft: { body: "Preview body" } } };
    },
  };
}

// ---------------------------------------------------------------------------
// Evidence parity with the legacy bridge
// ---------------------------------------------------------------------------

test("buildDraftEvidence matches the legacy pipeline.js implementation exactly", () => {
  // This is the shape the draft generator grounds every claim against, so a
  // divergence here silently changes what the model is allowed to assert.
  const cases: ResearchSelection[] = [
    selection(),
    selection({ source: { name: "Web", is_primary: false } }),
    selection({ verificationStatus: "web_source" }),
    selection({ evidenceUrl: "https://example.com/final" }),
    // Reddit-sourced: unverified with a distinct discovery URL adds a second
    // evidence item; the same URL must not.
    selection({
      unverified: true,
      source: { name: "r/news", is_primary: false },
      discoveryUrl: "https://reddit.example/thread",
    }),
    selection({
      unverified: true,
      source: { name: "r/news", is_primary: false },
      discoveryUrl: "https://example.com/story",
    }),
    selection({ unverified: true, source: { name: "r/news", is_primary: false }, discoveryUrl: null }),
    // `publisher ?? source.name` -- the research engines set publisher on
    // web-search candidates, and without this case the fallback branch is
    // never exercised (mutating it to always use source.name kept every test
    // green before this was added).
    selection({ publisher: "Independent Wire" }),
    selection({ publisher: "Independent Wire", unverified: true, source: { name: "r/news", is_primary: false }, discoveryUrl: "https://reddit.example/t" }),
    // verificationStatus explicitly set alongside unverified: pins the `??`
    // short-circuit rather than the unverified branch.
    selection({ verificationStatus: "primary_source", unverified: true }),
    // discoveryUrl equal to an explicit evidenceUrl (not just canonicalUrl).
    selection({
      unverified: true,
      source: { name: "r/news", is_primary: false },
      evidenceUrl: "https://example.com/final",
      discoveryUrl: "https://example.com/final",
    }),
  ];

  for (const candidate of cases) {
    assert.deepEqual(
      buildDraftEvidence(candidate),
      legacyBuildDraftEvidence(candidate),
      JSON.stringify(candidate),
    );
  }
});

// ---------------------------------------------------------------------------
// Tier escalation
// ---------------------------------------------------------------------------

test("a first-tier selection returns review_ready with that tier's window and never escalates", async () => {
  const queries: number[] = [];
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute(request) {
        queries.push(request.input.windowHours!);
        return { selected: selection() };
      },
    },
    editorialFake(),
  );

  const result = await adapter.run({ settingsSnapshot, lease });

  assert.deepEqual(result, {
    status: "review_ready",
    draftId: "draft-1",
    preview: "Preview body",
    windowHours: 24,
  });
  assert.deepEqual(
    queries,
    [24],
    "a successful first tier must not run the wider ones",
  );
});

test("a quiet day widens by one step rather than jumping to the weekly tier", async () => {
  const windows: number[] = [];
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute(request) {
        windows.push(request.input.windowHours!);
        if (windows.length === 1) throw noCandidates();
        return { selected: selection() };
      },
    },
    editorialFake(),
  );

  const result = await adapter.run({ settingsSnapshot, lease });

  assert.equal(result.status, "review_ready");
  // 48, not 168: skipping the middle tier would reach for week-old news the
  // moment today had none.
  assert.equal((result as { windowHours: number }).windowHours, 48);
  assert.deepEqual(windows, [24, 48]);
});

test("an empty first and second tier escalate to the seven-day tier", async () => {
  const windows: number[] = [];
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute(request) {
        windows.push(request.input.windowHours!);
        if (windows.length < 3) throw noCandidates();
        return { selected: selection() };
      },
    },
    editorialFake(),
  );

  const result = await adapter.run({ settingsSnapshot, lease });

  assert.equal(result.status, "review_ready");
  assert.equal((result as { windowHours: number }).windowHours, 24 * 7);
  assert.deepEqual(windows, [24, 48, 24 * 7]);
});

test("every tier empty reports no_candidates rather than throwing", async () => {
  // Legacy signalled this by letting NoResearchCandidatesError escape into
  // news-scheduler.js's catch; the scheduler port models it as a normal
  // terminal outcome instead.
  let attempts = 0;
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute() {
        attempts += 1;
        throw noCandidates();
      },
    },
    {
      async generateReviewDraft() {
        throw new Error("must not generate a draft with no selection");
      },
    },
  );

  assert.deepEqual(await adapter.run({ settingsSnapshot, lease }), { status: "no_candidates" });
  // Every tier in the ladder is tried before giving up -- asserted against the
  // plan rather than a literal, so adding a tier cannot quietly leave one
  // unexercised here.
  assert.equal(attempts, buildSearchPlan(settingsSnapshot).length);
  assert.equal(attempts, 3);
});

test("a non-empty-tier failure surfaces immediately instead of escalating", async () => {
  // Retrying a provider exhaustion or a persistence failure against a wider
  // window would burn a second paid search on an error that has nothing to do
  // with the window.
  const failure = Object.assign(new Error("No AI provider completed searchNews"), {
    name: "AiProvidersExhaustedError",
  });
  let attempts = 0;
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute() {
        attempts += 1;
        throw failure;
      },
    },
    editorialFake(),
  );

  await assert.rejects(adapter.run({ settingsSnapshot, lease }), (error) => error === failure);
  assert.equal(attempts, 1);
});

// ---------------------------------------------------------------------------
// Draft generation inputs
// ---------------------------------------------------------------------------

test("draft generation receives the lease, language, channel and allowUnverified derived from the source", async () => {
  const drafts: unknown[] = [];
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    { async execute() { return { selected: selection({ source: { name: "Web", is_primary: false } }) }; } },
    editorialFake(drafts),
  );

  await adapter.run({ settingsSnapshot, lease });

  const draftInput = drafts[0] as Record<string, unknown>;
  // Nothing else asserts the evidence array actually reaching the editorial
  // port, so a regression passing [] would otherwise go uncaught.
  assert.deepEqual(
    draftInput.evidence,
    buildDraftEvidence(selection({ source: { name: "Web", is_primary: false } })),
  );
  assert.deepEqual(draftInput.lease, { name: "news-pipeline", ownerId: "owner-1" });
  assert.equal(draftInput.languageCode, "en");
  assert.equal(draftInput.channelId, "@channel");
  // Legacy: allowUnverified: !selected.source.is_primary
  assert.equal(draftInput.allowUnverified, true);
  assert.equal(draftInput.settingsSnapshot, settingsSnapshot);
});

test("a primary source is not treated as unverified", async () => {
  const drafts: unknown[] = [];
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    { async execute() { return { selected: selection() }; } },
    editorialFake(drafts),
  );

  await adapter.run({ settingsSnapshot, lease });

  assert.equal((drafts[0] as Record<string, unknown>).allowUnverified, false);
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

test("a pre-aborted signal prevents any research or draft work", async () => {
  const controller = new AbortController();
  const cancellation = new Error("shutting down");
  controller.abort(cancellation);
  let touched = false;

  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    { async execute() { touched = true; return { selected: selection() }; } },
    editorialFake(),
  );

  await assert.rejects(
    adapter.run({ settingsSnapshot, lease, signal: controller.signal }),
    (error) => error === cancellation,
  );
  assert.equal(touched, false);
});

test("an abort between research and draft generation stops before generating", async () => {
  const controller = new AbortController();
  const cancellation = new Error("shutting down");
  let generated = false;

  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute() {
        controller.abort(cancellation);
        return { selected: selection() };
      },
    },
    {
      async generateReviewDraft() {
        generated = true;
        return { draft: { id: "draft-1" }, generation: { draft: { body: "b" } } };
      },
    },
  );

  await assert.rejects(
    adapter.run({ settingsSnapshot, lease, signal: controller.signal }),
    (error) => error === cancellation,
  );
  assert.equal(generated, false, "a cancelled run must not produce a draft");
});

test("the signal is forwarded into both collaborators", async () => {
  const controller = new AbortController();
  let researchSignal: AbortSignal | undefined;
  let editorialSignal: AbortSignal | undefined;

  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute(_request, signal) {
        researchSignal = signal;
        return { selected: selection() };
      },
    },
    {
      async generateReviewDraft(_input, signal) {
        editorialSignal = signal;
        return { draft: { id: "draft-1" }, generation: { draft: { body: "b" } } };
      },
    },
  );

  await adapter.run({ settingsSnapshot, lease, signal: controller.signal });

  assert.equal(researchSignal, controller.signal);
  assert.equal(editorialSignal, controller.signal);
});

// ---------------------------------------------------------------------------
// Pipeline lease ownership
// ---------------------------------------------------------------------------

test("a lease lost between research and generation fails before any generation tokens are spent", async () => {
  // src/pipeline.js calls heartbeat.assertOwned() here. Without it the run
  // executes a full paid generation under a lease it no longer owns and only
  // fails later at the create_review_draft SQL function.
  const lost = new Error("Pipeline lease ownership was lost");
  let generated = false;
  let researched = false;

  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    { async execute() { researched = true; return { selected: selection() }; } },
    {
      async generateReviewDraft() {
        generated = true;
        return { draft: { id: "draft-1" }, generation: { draft: { body: "b" } } };
      },
    },
  );

  await assert.rejects(
    adapter.run({
      settingsSnapshot,
      lease,
      assertOwned: () => { if (researched) throw lost; },
    }),
    (error) => error === lost,
  );
  assert.equal(researched, true);
  assert.equal(generated, false);
});

test("ownership is re-checked at the top of every tier, as legacy did per pipeline run", async () => {
  const checks: number[] = [];
  let tier = 0;

  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    {
      async execute() {
        tier += 1;
        if (tier === 1) throw noCandidates();
        return { selected: selection() };
      },
    },
    editorialFake(),
  );

  await adapter.run({
    settingsSnapshot,
    lease,
    assertOwned: () => { checks.push(tier); },
  });

  // Once before tier 1, once before tier 2, once before generation.
  assert.deepEqual(checks, [0, 1, 2]);
});

test("omitting assertOwned keeps the adapter working, so it stays an opt-in contract extension", async () => {
  const adapter = new TypedSchedulerNewsWorkflowAdapter(
    { async execute() { return { selected: selection() }; } },
    editorialFake(),
  );
  assert.equal((await adapter.run({ settingsSnapshot, lease })).status, "review_ready");
});

test("adapter is assignable to the exact port SchedulerApplicationModule requires", () => {
  const port: SchedulerNewsWorkflowApplicationPort = new TypedSchedulerNewsWorkflowAdapter(
    { async execute() { return { selected: selection() }; } },
    editorialFake(),
  );
  assert.equal(typeof port.run, "function");
});
