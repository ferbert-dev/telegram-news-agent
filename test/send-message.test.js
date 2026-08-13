import assert from "node:assert/strict";
import test from "node:test";

import { runSendMessageCli } from "../src/send-message.js";

test("telegram message preview is offline for text and file input", async (t) => {
  for (const args of [
    ["--text", " Offline preview "],
    ["--file", "article.txt"],
  ]) {
    await t.test(args[0], async () => {
      const calls = [];
      const result = await runSendMessageCli({
        args,
        dependencies: {
          readFile: async (path) => {
            calls.push(["read", path]);
            return " File preview ";
          },
          log: (line) => calls.push(["log", line]),
        },
      });
      assert.equal(result.status, "preview");
      assert.equal(
        calls.some(([name]) => name === "read"),
        args[0] === "--file",
      );
      assert.equal(calls.filter(([name]) => name === "log").length, 6);
    });
  }
});

test("direct --send fails closed before resolving Telegram, database, or provider state", async () => {
  let touched = false;
  await assert.rejects(
    runSendMessageCli({
      args: ["--text", "Direct update", "--send"],
      dependencies: {
        readFile: async () => { touched = true; },
        log: () => { touched = true; },
      },
    }),
    /Direct Telegram publication is disabled.*approved draft.*governed pipeline/,
  );
  assert.equal(touched, false);
});
