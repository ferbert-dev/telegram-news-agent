import { Client } from "pg";

/**
 * Serializes every test that makes a schedule row due.
 *
 * Lives in a subdirectory because `checks/integration/*.ts` does not cross a
 * directory boundary: a support file sitting alongside the checks is counted by
 * the runner as a passing test of its own, which quietly inflates the suite.
 *
 * `claim_due_news_schedule` is globally scoped -- it claims *any* due row, which
 * is right for production, where one runtime serves the schedule. But two
 * integration files that each park a channel at 1900-01-01 steal each other's
 * row: run them together and both fail, deterministically. They pass today only
 * because the runner happens not to schedule them concurrently, which is luck
 * rather than isolation -- a new integration file or a runner change would
 * break CI with a failure that looks like a scheduler bug.
 *
 * The lock uses its own connection rather than one from the caller's pool, so
 * it cannot be affected by the order in which a test ends its pool. A session
 * advisory lock is released when that connection closes, so a crashed test
 * cannot wedge the next run.
 */
export const DUE_SCHEDULE_LOCK_KEY = 864213;

export async function withDueScheduleLock<T>(
  connectionString: string,
  run: () => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [DUE_SCHEDULE_LOCK_KEY]);
    return await run();
  } finally {
    await client.end().catch(() => undefined);
  }
}
