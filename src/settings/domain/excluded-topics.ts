/**
 * Typed twin of `src/excluded-topics.js`.
 *
 * The legacy module stays unchanged as the rollback until the legacy runtime
 * is retired (see CLAUDE.md, "Architecture"). This file is a line-for-line
 * port -- same exported names, constants, defaults, and behaviour, with
 * strict types and no `any`. Do not let the two drift; if a real change is
 * needed here, it needs to be needed in the legacy module too, and that is a
 * deliberate, separately reviewed step.
 */

export interface ExcludedTopicLabels {
  en: string;
  uk: string;
  de: string;
}

export interface ExcludedTopicDefinition {
  code: string;
  labels: ExcludedTopicLabels;
  description: string;
}

export type ExcludedTopicRelation =
  | "main_subject"
  | "incidental"
  | "unrelated"
  | "uncertain";

export interface ExcludedTopicAssessment {
  topicCode: string;
  relation: ExcludedTopicRelation;
}

export const EXCLUDED_TOPIC_TAXONOMY: Readonly<
  Record<string, ExcludedTopicDefinition>
> = Object.freeze({
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

export const DEFAULT_EXCLUDED_TOPIC_CODES: readonly string[] = Object.freeze([
  "war_conflict",
]);

export const EXCLUDED_TOPIC_RELATIONS: readonly ExcludedTopicRelation[] =
  Object.freeze(["main_subject", "incidental", "unrelated", "uncertain"]);

const RELATIONS = new Set<string>(EXCLUDED_TOPIC_RELATIONS);

function canonicalCode(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function normalizeExcludedTopicCodes(
  value: unknown = DEFAULT_EXCLUDED_TOPIC_CODES,
): string[] {
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

function uncertain(topicCode: string): ExcludedTopicAssessment {
  return { topicCode, relation: "uncertain" };
}

function normalizeAssessments(
  value: unknown,
  topicCodes: string[],
): ExcludedTopicAssessment[] {
  // Line-for-line with the legacy `!value || !Array.isArray(value.assessments)`
  // guard: a plain type assertion, not a `typeof value === "object"` check.
  // The legacy guard is reachable by anything JavaScript lets carry an
  // `.assessments` property -- including a function -- and narrowing with
  // `typeof === "object"` would silently exclude that case and fail closed
  // to `uncertain` where legacy reads the property and proceeds normally.
  const candidate = value as { assessments?: unknown } | null | undefined;
  if (!candidate || !Array.isArray(candidate.assessments)) {
    return topicCodes.map(uncertain);
  }
  const assessments = candidate.assessments;
  const normalized = assessments.map((assessment) => {
    const candidate = assessment as
      | { topicCode?: unknown; relation?: unknown }
      | null
      | undefined;
    return {
      topicCode: canonicalCode(candidate?.topicCode),
      relation:
        typeof candidate?.relation === "string"
          ? candidate.relation.trim().toLowerCase()
          : "",
    };
  });
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
    return { topicCode, relation: assessment!.relation as ExcludedTopicRelation };
  });
}

export interface ExcludedTopicClassifyRequest {
  article: unknown;
  topicCodes: string[];
  taxonomy: ExcludedTopicDefinition[];
  relations: ExcludedTopicRelation[];
}

export type ExcludedTopicClassifier = (
  request: ExcludedTopicClassifyRequest,
) => Promise<unknown> | unknown;

export interface EvaluateExcludedTopicsInput {
  article: unknown;
  excludedTopicCodes?: unknown;
  classify?: ExcludedTopicClassifier;
}

/**
 * Provider-neutral evaluator contract. The caller supplies a classifier; this
 * module only bounds its request and fails closed to `uncertain`. Provider
 * selection, policy decisions, and pipeline wiring remain caller-owned.
 */
export async function evaluateExcludedTopics({
  article,
  excludedTopicCodes = DEFAULT_EXCLUDED_TOPIC_CODES,
  classify,
}: EvaluateExcludedTopicsInput): Promise<ExcludedTopicAssessment[]> {
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
