import assert from "node:assert/strict";
import test from "node:test";
import {
  appendEditorCredit,
  DEFAULT_NEWS_EDITOR,
  getEditorDisplayName,
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

test("the default editor pseudonym is fixed for every supported article language", () => {
  assert.equal(getEditorDisplayName(DEFAULT_NEWS_EDITOR, "en"), "Michail Honest");
  assert.equal(getEditorDisplayName(DEFAULT_NEWS_EDITOR, "de"), "Michail Honest");
  assert.equal(getEditorDisplayName(DEFAULT_NEWS_EDITOR, "uk"), "Michail Honest");
  assert.equal(
    getEditorDisplayName(DEFAULT_NEWS_EDITOR, "unsupported"),
    "Michail Honest",
  );
  assert.equal(
    getEditorDisplayName({ key: "anna", name: "Anna Beispiel" }, "uk"),
    "Anna Beispiel",
  );
});

test("localized editor credit appears before sources and remains idempotent", () => {
  const cases = [
    {
      languageCode: "en",
      text: "Headline\n\nNews text.\n\nSources:\nhttps://example.com",
      expected: "Found and prepared for you by Michail Honest\n\nSources:",
    },
    {
      languageCode: "de",
      text: "Überschrift\n\nNachricht.\n\nQuellen:\nhttps://example.com",
      expected: "Für Sie gefunden und aufbereitet von Michail Honest\n\nQuellen:",
    },
    {
      languageCode: "uk",
      text: "Заголовок\n\nТекст новини.\n\nДжерела:\nhttps://example.com",
      expected: "Знайшов і підготував для вас: Michail Honest\n\nДжерела:",
    },
  ];

  for (const { languageCode, text, expected } of cases) {
    const credited = appendEditorCredit(text, DEFAULT_NEWS_EDITOR, languageCode);
    assert.ok(credited.includes(expected));
    assert.equal(
      appendEditorCredit(credited, DEFAULT_NEWS_EDITOR, languageCode),
      credited,
    );
  }
});
