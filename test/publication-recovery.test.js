import assert from "node:assert/strict";
import test from "node:test";
import { reconcilePublication } from "../src/publication-recovery.js";

test("reconcilePublication records an operator-confirmed send without sending", async () => {
  const calls = [];
  const repository = {
    async getDraft(id) {
      calls.push(["get", id]);
      return { id, body: "Published text" };
    },
    async finalizeDraftPublication(input) {
      calls.push(["finalize", input]);
      return { id: "post-1", telegram_message_id: input.messageId };
    },
  };

  const result = await reconcilePublication({
    repository,
    draftId: "draft-1",
    outcome: "sent",
    channelId: "@channel",
    messageId: 42,
  });

  assert.equal(result.publication.telegram_message_id, 42);
  assert.deepEqual(calls[1][1].metadata, {
    approval: "database_approved",
    reconciliation: "operator_confirmed_sent",
  });
});

test("reconcilePublication releases an operator-confirmed non-send", async () => {
  const repository = {
    async resetDraftPublication(id, confirmation) {
      assert.equal(id, "draft-1");
      assert.equal(confirmation, "TELEGRAM_NOT_SENT");
      return { id, status: "approved" };
    },
  };

  const result = await reconcilePublication({
    repository,
    draftId: "draft-1",
    outcome: "not-sent",
  });
  assert.equal(result.draft.status, "approved");
});

test("reconcilePublication validates the outcome and Telegram message ID", async () => {
  await assert.rejects(
    reconcilePublication({
      repository: {},
      draftId: "draft-1",
      outcome: "sent",
      messageId: 0,
    }),
    /positive Telegram message ID/,
  );
  await assert.rejects(
    reconcilePublication({
      repository: {},
      draftId: "draft-1",
      outcome: "unknown",
    }),
    /sent or not-sent/,
  );
});
