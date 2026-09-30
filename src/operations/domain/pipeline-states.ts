/**
 * Typed twin of `src/pipeline-states.js`.
 *
 * The legacy module stays unchanged as the rollback until the legacy runtime
 * is retired (see CLAUDE.md, "Architecture"). This file is a line-for-line
 * port -- same exported names, constants, defaults, and behaviour, with
 * strict types and no `any`. Do not let the two drift; if a real change is
 * needed here, it needs to be needed in the legacy module too, and that is a
 * deliberate, separately reviewed step.
 */

type TransitionEntity = "searchRun" | "article" | "draft";

const TRANSITIONS: Record<TransitionEntity, Record<string, Set<string>>> = {
  searchRun: {
    running: new Set(["completed", "failed"]),
    completed: new Set(),
    failed: new Set(),
  },
  article: {
    discovered: new Set(["extracted", "rejected", "failed"]),
    extracted: new Set(["reviewed", "rejected", "failed"]),
    reviewed: new Set(["drafted", "rejected", "failed"]),
    drafted: new Set(["approved", "rejected", "failed"]),
    approved: new Set(["published", "rejected", "failed"]),
    published: new Set(),
    rejected: new Set(),
    failed: new Set(),
  },
  draft: {
    draft: new Set(["review", "rejected"]),
    review: new Set(["approved", "rejected"]),
    approved: new Set(["publishing", "rejected"]),
    publishing: new Set(["published", "approved"]),
    published: new Set(),
    rejected: new Set(),
  },
};

export function assertTransition(
  entity: string,
  from: string,
  to: string,
): void {
  const entityTransitions = TRANSITIONS[entity as TransitionEntity];

  if (!entityTransitions) {
    throw new Error(`Unknown state entity: ${entity}`);
  }

  const allowedTargets = entityTransitions[from];

  if (!allowedTargets) {
    throw new Error(`Unknown ${entity} state: ${from}`);
  }

  if (!allowedTargets.has(to)) {
    throw new Error(`Invalid ${entity} transition: ${from} -> ${to}`);
  }
}
