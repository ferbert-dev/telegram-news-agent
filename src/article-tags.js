const ARTICLE_TAGGING_STATES = new Set(["off", "collect", "enabled"]);
const SAFE_TAG_CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const SAFE_HASHTAG = /^#[\p{L}\p{N}_]+$/u;

// Labs V1 keeps lower-confidence classifications for evaluation, but only
// exposes tags at or above 0.60 to channel readers.
export const PUBLIC_TOPIC_TAG_CONFIDENCE_THRESHOLD = 0.6;

function normalizedText(value, name, { maxLength }) {
  if (typeof value !== "string") {
    throw new Error(`${name} must be text`);
  }
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || normalized.length > maxLength || /[\r\n]/.test(normalized)) {
    throw new Error(`${name} must contain 1-${maxLength} characters on one line`);
  }
  return normalized;
}

function normalizedCode(value) {
  const code = normalizedText(value, "Topic tag code", { maxLength: 64 });
  if (!SAFE_TAG_CODE.test(code)) {
    throw new Error("Topic tag code must be a safe lowercase slug");
  }
  return code;
}

function normalizedHashtag(value, name = "Topic hashtag") {
  const hashtag = normalizedText(value, name, { maxLength: 64 });
  if (!SAFE_HASHTAG.test(hashtag)) {
    throw new Error(`${name} must start with # and contain only letters, numbers, or underscores`);
  }
  return hashtag;
}

function normalizedHashtags(value) {
  if (typeof value === "string") {
    return Object.freeze({ default: normalizedHashtag(value) });
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Topic hashtag must be text or a localized hashtag map");
  }
  const entries = Object.entries(value);
  if (!entries.length) {
    throw new Error("Localized topic hashtag map must not be empty");
  }
  const hashtags = Object.fromEntries(
    entries.map(([languageCode, hashtag]) => {
      if (!/^(?:default|en|uk|de)$/.test(languageCode)) {
        throw new Error(`Unsupported topic hashtag language: ${languageCode}`);
      }
      return [
        languageCode,
        normalizedHashtag(hashtag, `Topic hashtag (${languageCode})`),
      ];
    }),
  );
  return Object.freeze(hashtags);
}

export function validateArticleTagCatalog(catalog) {
  if (!Array.isArray(catalog)) {
    throw new Error("Article tag catalog must be an array");
  }
  const seenCodes = new Set();
  const normalized = [];
  for (const entry of catalog) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Article tag catalog entries must be objects");
    }
    if (entry.enabled === false) {
      continue;
    }
    const code = normalizedCode(entry.code);
    if (seenCodes.has(code)) {
      throw new Error(`Duplicate article tag code: ${code}`);
    }
    seenCodes.add(code);
    const label = normalizedText(entry.label, "Topic tag label", {
      maxLength: 120,
    });
    const description =
      entry.description == null
        ? null
        : normalizedText(entry.description, "Topic tag description", {
            maxLength: 500,
          });
    normalized.push(
      Object.freeze({
        code,
        label,
        description,
        hashtags: normalizedHashtags(entry.hashtags ?? entry.hashtag),
      }),
    );
  }
  return Object.freeze(normalized);
}

export function normalizeArticleTagging(articleTagging = undefined) {
  const state = String(articleTagging?.state ?? "off")
    .trim()
    .toLowerCase();
  if (!ARTICLE_TAGGING_STATES.has(state)) {
    throw new Error("Article tagging state must be off, collect, or enabled");
  }
  if (state === "off") {
    return Object.freeze({ state, catalog: Object.freeze([]) });
  }
  const catalog = validateArticleTagCatalog(articleTagging?.catalog ?? []);
  return Object.freeze({ state, catalog });
}

export function validateTopicTagAssignments(assignments, articleTagging) {
  const tagging = normalizeArticleTagging(articleTagging);
  if (tagging.state === "off") {
    return Object.freeze([]);
  }
  if (!Array.isArray(assignments)) {
    throw new Error("Topic tag assignments must be an array");
  }
  if (assignments.length > 3) {
    throw new Error("At most three topic tags may be assigned");
  }
  const catalogCodes = new Set(tagging.catalog.map(({ code }) => code));
  const seenCodes = new Set();
  const normalized = assignments.map((assignment) => {
    if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
      throw new Error("Topic tag assignments must be objects");
    }
    const code = normalizedCode(assignment.code);
    if (!catalogCodes.has(code)) {
      throw new Error(`Topic tag is not in the enabled catalog: ${code}`);
    }
    if (seenCodes.has(code)) {
      throw new Error(`Duplicate topic tag assignment: ${code}`);
    }
    seenCodes.add(code);
    const confidence = assignment.confidence;
    if (
      typeof confidence !== "number" ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      throw new Error("Topic tag confidence must be between 0 and 1");
    }
    return Object.freeze({ code, confidence });
  });
  return Object.freeze(normalized);
}

function hashtagForLanguage(entry, languageCode) {
  return (
    entry.hashtags[languageCode] ??
    entry.hashtags.default ??
    entry.hashtags.en ??
    Object.values(entry.hashtags)[0]
  );
}

export function renderTopicHashtags(
  assignments,
  articleTagging,
  {
    languageCode = "en",
    confidenceThreshold = PUBLIC_TOPIC_TAG_CONFIDENCE_THRESHOLD,
  } = {},
) {
  if (
    !Number.isFinite(confidenceThreshold) ||
    confidenceThreshold < 0 ||
    confidenceThreshold > 1
  ) {
    throw new Error("Topic hashtag confidence threshold must be between 0 and 1");
  }
  const tagging = normalizeArticleTagging(articleTagging);
  const validated = validateTopicTagAssignments(assignments, tagging);
  if (tagging.state !== "enabled") {
    return "";
  }
  const catalogIndex = new Map(
    tagging.catalog.map((entry, index) => [entry.code, { entry, index }]),
  );
  const hashtags = [];
  const seenHashtags = new Set();
  for (const assignment of [...validated]
    .filter(({ confidence }) => confidence >= confidenceThreshold)
    .sort(
      (left, right) =>
        right.confidence - left.confidence ||
        catalogIndex.get(left.code).index - catalogIndex.get(right.code).index ||
        left.code.localeCompare(right.code),
    )) {
    const hashtag = hashtagForLanguage(
      catalogIndex.get(assignment.code).entry,
      languageCode,
    );
    const identity = hashtag.normalize("NFKC").toLocaleLowerCase();
    if (!seenHashtags.has(identity)) {
      seenHashtags.add(identity);
      hashtags.push(hashtag);
    }
    if (hashtags.length === 3) break;
  }
  return hashtags.join(" ");
}

export function appendTopicHashtags(
  text,
  assignments,
  articleTagging,
  options = {},
) {
  if (typeof text !== "string") {
    throw new Error("Telegram draft text must be text");
  }
  const hashtagLine = renderTopicHashtags(
    assignments,
    articleTagging,
    options,
  );
  if (!hashtagLine) {
    return text;
  }
  const normalized = text.trimEnd();
  if (normalized === hashtagLine || normalized.endsWith(`\n\n${hashtagLine}`)) {
    return text;
  }
  return `${normalized}\n\n${hashtagLine}`;
}
