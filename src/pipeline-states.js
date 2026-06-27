const TRANSITIONS = {
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

export function assertTransition(entity, from, to) {
  const entityTransitions = TRANSITIONS[entity];

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
