import assert from "node:assert/strict";
import test from "node:test";
import {
  renderDeploymentNotification,
  sendDeploymentNotifications,
} from "../src/deployment-notification.js";

test("deployment notification is sent only to distinct private review chats", async () => {
  const calls = [];
  const outcome = await sendDeploymentNotifications({
    chatIds: ["9", "9", "-1001"],
    version: "v0.1.0+abcdef0",
    token: "token",
    telegram: async (_token, method, body) => {
      calls.push([method, body]);
      if (method === "getChat") {
        return { type: body.chat_id === "9" ? "private" : "channel" };
      }
      return { message_id: 1 };
    },
  });
  assert.deepEqual(outcome, {
    eligible: 1,
    sent: 1,
    skipped: 1,
    failed: 0,
  });
  assert.equal(calls.filter(([method]) => method === "sendMessage").length, 1);
  assert.match(renderDeploymentNotification("v0.1.0+abcdef0"), /healthy/);
});
