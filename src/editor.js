import { validateMessage } from "./telegram.js";

export const DEFAULT_NEWS_EDITOR = Object.freeze({
  key: "mikhail-onest",
  name: "Михаил Онест",
});

const DEFAULT_EDITOR_LOCALIZED_NAMES = Object.freeze({
  en: "Michail Honest",
  de: "Michail Honest",
  uk: "Michail Honest",
});

const BYLINE = Object.freeze({
  en: (name) => `Found and prepared for you by ${name}`,
  uk: (name) => `Знайшов і підготував для вас: ${name}`,
  de: (name) => `Für Sie gefunden und aufbereitet von ${name}`,
});

export function getNewsEditor(env = process.env) {
  const key = env.NEWS_EDITOR_KEY?.trim() || DEFAULT_NEWS_EDITOR.key;
  const name = env.NEWS_EDITOR_NAME?.trim() || DEFAULT_NEWS_EDITOR.name;
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(key)) {
    throw new Error("NEWS_EDITOR_KEY must be a lowercase slug");
  }
  if (name.length < 2 || name.length > 80 || /[\r\n]/.test(name)) {
    throw new Error("NEWS_EDITOR_NAME must contain 2-80 characters on one line");
  }
  return Object.freeze({ key, name });
}

export function getEditorDisplayName(editor, languageCode = "en") {
  const isDefaultEditor =
    editor.key === DEFAULT_NEWS_EDITOR.key && editor.name === DEFAULT_NEWS_EDITOR.name;
  return isDefaultEditor
    ? (DEFAULT_EDITOR_LOCALIZED_NAMES[languageCode] ??
        DEFAULT_EDITOR_LOCALIZED_NAMES.en)
    : editor.name;
}

export function appendEditorCredit(text, editor, languageCode = "en") {
  const byline = (BYLINE[languageCode] ?? BYLINE.en)(
    getEditorDisplayName(editor, languageCode),
  );
  if (text.includes(byline)) return text;
  const sourceHeading = /\n\s*(Sources?|Quellen?|Джерела|Джерело):\s*\n/iu;
  const match = sourceHeading.exec(text);
  const credited = match
    ? `${text.slice(0, match.index).trim()}\n\n${byline}\n\n${text.slice(match.index).trimStart()}`
    : `${text.trim()}\n\n${byline}`;
  return validateMessage(credited);
}
