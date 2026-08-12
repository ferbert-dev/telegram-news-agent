import assert from "node:assert/strict";
import test from "node:test";

import { formatPipelineOutcome } from "../src/pipeline-cli.js";

test("pipeline CLI reports policy block as terminal without claiming manual review", () => {
  const formatted = formatPipelineOutcome(
    {
      status: "blocked_by_policy",
      runId: "run-1",
      article: { id: "article-1" },
      draft: { id: "draft-1" },
      publication: null,
      provider: "configured-provider",
      model: "configured-model",
      feedErrors: [],
      preview: "Blocked preview",
    },
    "automatic",
  );

  assert.equal(formatted.auditResult, "Draft draft-1 was blocked by the excluded-topic policy; no Telegram message was sent.");
  assert.deepEqual(formatted.output, {
    event: "pipeline_blocked_by_policy",
    run_id: "run-1",
    article_id: "article-1",
    draft_id: "draft-1",
    approval_policy: "automatic",
    telegram_message_id: null,
    feed_errors: [],
    ai_provider: "configured-provider",
    ai_model: "configured-model",
  });
});
