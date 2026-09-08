/**
 * When the poller last completed a call to Telegram.
 *
 * This exists because every readiness condition could hold while nothing was
 * being served. A permanently failing `getUpdates` -- a revoked token, a
 * lasting partition -- backs off and retries forever without surrendering the
 * lease, so the process is up, the lease is held, every worker is started, and
 * the probe says healthy. The only signal that separates that state from a
 * working one is whether a poll has actually succeeded recently, and nothing
 * was recording it.
 *
 * Deliberately the smallest possible surface: one writer, one reader, no
 * transport. The poller does not know what reads it and the probe does not
 * know what writes it.
 */
export type PollActivityRecorder = {
  /** Called after each completed Telegram poll, successful or empty. */
  mark(at: Date): void;
  /** ISO timestamp of the last completed poll, or null if there has been none. */
  lastPolledAt(): string | null;
};

export function createPollActivityRecorder(): PollActivityRecorder {
  let last: string | null = null;
  return {
    mark(at: Date) {
      last = at.toISOString();
    },
    lastPolledAt() {
      return last;
    },
  };
}
