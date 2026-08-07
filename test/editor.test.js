import assert from "node:assert/strict";
import test from "node:test";
import {
  appendEditorCredit,
  DEFAULT_NEWS_EDITOR,
  getNewsEditor,
} from "../src/editor.js";

test("default editor is configurable without accepting multiline names", () => {
  assert.deepEqual(getNewsEditor({}), DEFAULT_NEWS_EDITOR);
  assert.deepEqual(
    getNewsEditor({ NEWS_EDITOR_KEY: "second-editor", NEWS_EDITOR_NAME: "Anna" }),
    { key: "second-editor", name: "Anna" },
  );
  assert.throws(
    () => getNewsEditor({ NEWS_EDITOR_NAME: "Bad\nName" }),
    /one line/,
  );
});

test("editor credit appears before localized sources and remains idempotent", () => {
  const credited = appendEditorCredit(
    "Headline\n\nNews text.\n\nQuellen:\nhttps://example.com",
    DEFAULT_NEWS_EDITOR,
    "de",
  );
  assert.match(credited, /aufbereitet von Михаил Онест\n\nQuellen:/);
  assert.equal(
    appendEditorCredit(credited, DEFAULT_NEWS_EDITOR, "de"),
    credited,
  );
});
