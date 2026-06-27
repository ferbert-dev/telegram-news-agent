import test from "node:test";
import assert from "node:assert/strict";
import { publishApprovedDraft } from "../src/publish.js";

test("publishApprovedDraft records a claimed draft after Telegram accepts it", async () => {
  const calls = [];
  const repository = {
    async findPublicationByDraft() {
      return null;
    },
    async claimDraftForPublication(id) {
      calls.push(["claim", id]);
      return { id, body: "Approved article" };
    },
    async finalizeDraftPublication(details) {
      calls.push(["finalize", details.messageId]);
      return { telegram_message_id: details.messageId };
    },
  };
  const result = await publishApprovedDraft({
    repository,
    token: "token",
    channelId: "@channel",
    draftId: "draft-1",
    sendMessage: async () => ({ message_id: 42, date: 123 }),
  });

  assert.equal(result.publication.telegram_message_id, 42);
  assert.deepEqual(calls, [
    ["claim", "draft-1"],
    ["finalize", 42],
  ]);
});

test("publishApprovedDraft returns an existing publication without sending", async () => {
  let sent = false;
  const publication = { telegram_message_id: 7 };
  const result = await publishApprovedDraft({
    repository: {
      async findPublicationByDraft() {
        return publication;
      },
    },
    token: "token",
    channelId: "@channel",
    draftId: "draft-1",
    sendMessage: async () => {
      sent = true;
    },
  });

  assert.equal(result.alreadyPublished, true);
  assert.equal(sent, false);
});

test("publishApprovedDraft leaves an ambiguous failure unresolved", async () => {
  let finalized = false;
  await assert.rejects(
    publishApprovedDraft({
      repository: {
        async findPublicationByDraft() {
          return null;
        },
        async claimDraftForPublication(id) {
          return { id, body: "Approved article" };
        },
        async finalizeDraftPublication() {
          finalized = true;
        },
      },
      token: "token",
      channelId: "@channel",
      draftId: "draft-1",
      sendMessage: async () => {
        throw new Error("connection reset");
      },
    }),
    /remains in publishing state/,
  );
  assert.equal(finalized, false);
});
