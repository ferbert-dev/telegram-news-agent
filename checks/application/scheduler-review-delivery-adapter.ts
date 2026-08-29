import assert from "node:assert/strict";
import test from "node:test";

import {
  TelegramSchedulerReviewDeliveryAdapter,
  type TelegramReviewDeliveryPort,
} from "../../src/scheduler/telegram-scheduler-review-delivery.adapter.js";
import { DeliverTelegramReviewUseCase } from "../../src/telegram/application/deliver-telegram-review.use-case.js";

import type { SchedulerReviewDeliveryApplicationPort } from "../../src/scheduler/scheduler-application.contracts.js";

const input = {
  channelId: "@channel",
  chatId: 4242,
  requestedBy: 77,
  draftId: "draft-1",
  preview: "Preview text",
};

test("adapter translates requestedBy to actorId and forwards every other field unchanged", async () => {
  const calls: unknown[] = [];
  const adapter = new TelegramSchedulerReviewDeliveryAdapter({
    async execute(received) {
      calls.push(received);
      return { status: "review_ready" };
    },
  });

  await adapter.deliver(input);

  assert.deepEqual(calls, [
    {
      draftId: "draft-1",
      channelId: "@channel",
      chatId: 4242,
      actorId: 77,
      preview: "Preview text",
      signal: undefined,
    },
  ]);
});

test("adapter narrows a review_ready outcome and reports resumed as a strict boolean", async () => {
  const fresh = new TelegramSchedulerReviewDeliveryAdapter({
    async execute() {
      // The use case returns extra fields (sessionId, previewMessageId) that
      // the scheduler port does not declare; they must not leak through.
      return { status: "review_ready", draftId: "draft-1", sessionId: "s-1", previewMessageId: 9 };
    },
  });
  assert.deepEqual(await fresh.deliver(input), { status: "review_ready", resumed: false });

  const resumed = new TelegramSchedulerReviewDeliveryAdapter({
    async execute() {
      return { status: "review_ready", resumed: true, sessionId: "s-1" };
    },
  });
  assert.deepEqual(await resumed.deliver(input), { status: "review_ready", resumed: true });

  // A truthy non-boolean is what actually distinguishes `=== true` from a
  // loose `!!` coercion; without this the "strict" in the title is untested.
  const truthy = new TelegramSchedulerReviewDeliveryAdapter({
    async execute() {
      return { status: "review_ready", resumed: 1 };
    },
  });
  assert.deepEqual(await truthy.deliver(input), { status: "review_ready", resumed: false });
});

test("adapter passes a resolved decision through and normalizes anything else to null", async () => {
  for (const decision of ["publish", "reject"] as const) {
    const adapter = new TelegramSchedulerReviewDeliveryAdapter({
      async execute() {
        return { status: "review_unavailable", decision, resumed: true };
      },
    });
    assert.deepEqual(await adapter.deliver(input), {
      status: "review_unavailable",
      decision,
      resumed: true,
    });
  }

  // An expired-or-rebound session reports unavailable with no decision at all.
  const undecided = new TelegramSchedulerReviewDeliveryAdapter({
    async execute() {
      return { status: "review_unavailable", resumed: true };
    },
  });
  assert.deepEqual(await undecided.deliver(input), {
    status: "review_unavailable",
    decision: null,
    resumed: true,
  });

  // A value outside the union must never be forwarded as if it were a decision.
  const bogus = new TelegramSchedulerReviewDeliveryAdapter({
    async execute() {
      return { status: "review_unavailable", decision: "escalate" };
    },
  });
  assert.deepEqual(await bogus.deliver(input), {
    status: "review_unavailable",
    decision: null,
    resumed: false,
  });
});

test("adapter fails loudly on an unrecognized status rather than degrading to unavailable", async () => {
  // Silently mapping an unknown status onto "review_unavailable" would let the
  // scheduler pause a schedule or discard a delivered draft on the strength of
  // a status nobody checked.
  const adapter = new TelegramSchedulerReviewDeliveryAdapter({
    async execute() {
      return { status: "claim_lost" };
    },
  });

  await assert.rejects(
    adapter.deliver(input),
    /unsupported status: claim_lost/,
  );
});

test("adapter forwards an abort signal and propagates the use case's own rejection unchanged", async () => {
  const controller = new AbortController();
  let seenSignal: AbortSignal | undefined;
  const forwarding = new TelegramSchedulerReviewDeliveryAdapter({
    async execute(received) {
      seenSignal = received.signal;
      return { status: "review_ready" };
    },
  });
  await forwarding.deliver({ ...input, signal: controller.signal });
  assert.equal(seenSignal, controller.signal);

  const failure = new Error("review session persistence failed");
  const failing = new TelegramSchedulerReviewDeliveryAdapter({
    async execute() {
      throw failure;
    },
  });
  await assert.rejects(failing.deliver(input), (error) => error === failure);
});

test("the real DeliverTelegramReviewUseCase satisfies the adapter's structural port", () => {
  // The tests above drive the adapter with hand-written fakes, and the port's
  // return type ({status: string, [key: string]: unknown}) is wide enough that
  // any object literal satisfies it. Without this, renaming actorId or adding a
  // required field to DeliverTelegramReviewInput would leave every test and the
  // whole typecheck green, and only break when someone finally wires the two
  // together in a composition root.
  const shape: TelegramReviewDeliveryPort = {} as DeliverTelegramReviewUseCase;
  assert.ok(shape);
});

test("adapter is assignable to the exact port SchedulerApplicationModule requires", () => {
  const port: SchedulerReviewDeliveryApplicationPort =
    new TelegramSchedulerReviewDeliveryAdapter({
      async execute() {
        return { status: "review_ready" };
      },
    });
  assert.equal(typeof port.deliver, "function");
});
