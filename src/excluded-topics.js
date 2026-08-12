export const EXCLUDED_TOPIC_TAXONOMY = Object.freeze({
  war_conflict: Object.freeze({
    code: "war_conflict",
    labels: Object.freeze({
      en: "War & armed conflict",
      uk: "Війна та збройні конфлікти",
      de: "Krieg und bewaffnete Konflikte",
    }),
    description:
      "War, armed conflict, combat operations, military attacks, and their direct consequences.",
  }),
});

export const DEFAULT_EXCLUDED_TOPIC_CODES = Object.freeze(["war_conflict"]);
export const EXCLUDED_TOPIC_RELATIONS = Object.freeze([
  "main_subject",
  "incidental",
  "unrelated",
  "uncertain",
]);

const RELATIONS = new Set(EXCLUDED_TOPIC_RELATIONS);

function canonicalCode(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeExcludedTopicCodes(
  value = DEFAULT_EXCLUDED_TOPIC_CODES,
) {
  if (!Array.isArray(value)) {
    throw new Error("excludedTopicCodes must be an array");
  }
  const normalized = [...new Set(value.map(canonicalCode))];
  const unknown = normalized.filter(
    (code) => !Object.hasOwn(EXCLUDED_TOPIC_TAXONOMY, code),
  );
  if (unknown.length) {
    throw new Error(`Unknown excluded topic code: ${unknown.join(", ")}`);
  }
  return normalized;
}

function uncertain(topicCode) {
  return { topicCode, relation: "uncertain" };
}

function normalizeAssessments(value, topicCodes) {
  if (!value || !Array.isArray(value.assessments)) {
    return topicCodes.map(uncertain);
  }
  const normalized = value.assessments.map((assessment) => ({
    topicCode: canonicalCode(assessment?.topicCode),
    relation:
      typeof assessment?.relation === "string"
        ? assessment.relation.trim().toLowerCase()
        : "",
  }));
  const codes = normalized.map(({ topicCode }) => topicCode);
  const structurallyValid =
    normalized.length === topicCodes.length &&
    new Set(codes).size === codes.length &&
    codes.every((code) => topicCodes.includes(code)) &&
    topicCodes.every((code) => codes.includes(code)) &&
    normalized.every(({ relation }) => RELATIONS.has(relation));
  if (!structurallyValid) {
    return topicCodes.map(uncertain);
  }
  return topicCodes.map((topicCode) => {
    const assessment = normalized.find(
      (candidate) => candidate.topicCode === topicCode,
    );
    return { topicCode, relation: assessment.relation };
  });
}

/**
 * Provider-neutral evaluator contract. The caller supplies a classifier; this
 * module only bounds its request and fails closed to `uncertain`. It is not
 * connected to research, curation, drafting, approval, or publication here.
 */
export async function evaluateExcludedTopics({
  article,
  excludedTopicCodes = DEFAULT_EXCLUDED_TOPIC_CODES,
  classify,
}) {
  const topicCodes = normalizeExcludedTopicCodes(excludedTopicCodes);
  if (!topicCodes.length) {
    return [];
  }
  if (typeof classify !== "function") {
    return topicCodes.map(uncertain);
  }
  try {
    const result = await classify({
      article,
      topicCodes: [...topicCodes],
      taxonomy: topicCodes.map((code) => EXCLUDED_TOPIC_TAXONOMY[code]),
      relations: [...EXCLUDED_TOPIC_RELATIONS],
    });
    return normalizeAssessments(result, topicCodes);
  } catch {
    return topicCodes.map(uncertain);
  }
}
