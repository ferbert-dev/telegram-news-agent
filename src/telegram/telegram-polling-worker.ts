import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import type { RuntimeWorker } from "../runtime/runtime-coordinator.js";
import {
  isTerminalTelegramControlError,
  TelegramControlError,
} from "./telegram-application.contracts.js";
import type { TelegramControlRawUpdate } from "./transport/telegram-control-update.parser.js";
import type {
  RecordTelegramUpdateFailureInput,
  TelegramUpdatesPersistence,
} from "./telegram-persistence.contracts.js";
import type { PipelineLeaseApplicationPort } from "../operations/operations-application.contracts.js";
import { TelegramError } from "../telegram.js";

export const TELEGRAM_CONTROL_POLLER_LEASE_NAME = "telegram-control-poller";
export const TELEGRAM_CONTROL_POLLER_LEASE_TTL_SECONDS = 60;
export const TELEGRAM_CONTROL_POLLER_HEARTBEAT_INTERVAL_MS = 20_000;
export const TELEGRAM_CONTROL_POLLER_ACQUIRE_TIMEOUT_MS = 70_000;
export const TELEGRAM_CONTROL_POLLER_ACQUIRE_RETRY_MS = 2_000;
export const TELEGRAM_CONTROL_POLLER_MAX_UPDATE_ATTEMPTS = 3;
export const TELEGRAM_CONTROL_POLLER_MAX_FAILURE_LEDGER_ATTEMPTS = 3;
export const TELEGRAM_CONTROL_POLLER_MAX_BACKOFF_MS = 30_000;

const UPDATE_BODY_FIELDS = [
  "message",
  "callback_query",
  "message_reaction",
  "message_reaction_count",
] as const;

type RecordUpdate = {
  update_id: number;
  message?: unknown;
  callback_query?: unknown;
  message_reaction?: unknown;
  message_reaction_count?: unknown;
  [key: string]: unknown;
};

export type TelegramPollerLog = {
  error(message: string): void;
  warn?(message: string): void;
};

export type TelegramPollerConfig = {
  token: string;
  ownerId?: string;
  callTelegram: TelegramCallGateway;
  transport: TelegramControlTransport;
  updates: TelegramUpdatesPersistence;
  leaseApplication: PipelineLeaseApplicationPort;
  sleepImpl?: (delayMs: number, _value?: unknown, options?: {
    signal?: AbortSignal;
  }) => Promise<unknown>;
  random?: () => number;
  log?: TelegramPollerLog;
  nowImpl?: () => number;
  heartbeatIntervalMs?: number;
  leaseAcquireTimeoutMs?: number;
  leaseAcquireRetryMs?: number;
  maxUpdateAttempts?: number;
  maxFailureLedgerAttempts?: number;
  staleAfterSeconds?: number;
};

type TelegramCallGateway = (
  token: string,
  method: string,
  payload: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

export type TelegramControlTransport = {
  handle(
    update: TelegramControlRawUpdate,
    options?: { signal?: AbortSignal },
  ): Promise<{ handled: boolean }>;
};

export type TelegramUpdateClassification = {
  readonly updateId: number;
  readonly kind: string;
  readonly terminal: boolean;
  readonly errorCode?: string;
};

export class PollingLeaseLostError extends Error {
  constructor() {
    super("Telegram polling lease was lost");
    this.name = "PollingLeaseLostError";
  }
}

export class TelegramUpdateProtocolError extends Error {
  constructor(code: string) {
    super(`Invalid Telegram update protocol payload: ${code}`);
    this.name = "TelegramUpdateProtocolError";
    this.code = code;
  }

  readonly code: string;
}

export class TelegramUpdatePersistenceError extends Error {
  constructor() {
    super("Telegram update failure ledger remained unavailable");
    this.name = "TelegramUpdatePersistenceError";
  }
}

export class NonRetryableTelegramUpdateError extends Error {
  constructor(code = "non_retryable_update") {
    super("Telegram update cannot be retried safely");
    this.name = "NonRetryableTelegramUpdateError";
    this.code = sanitizeErrorCode(code, "non_retryable_update");
    this.retryable = false;
  }

  readonly code: string;
  readonly retryable: boolean;
}

function sanitizeErrorCode(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/u.test(value)
    ? value
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function malformed(updateId: number, errorCode: string): TelegramUpdateClassification {
  return {
    updateId,
    kind: "malformed",
    terminal: true,
    errorCode,
  };
}

export function classifyTelegramUpdate(update: unknown): TelegramUpdateClassification {
  if (
    !isRecord(update) ||
    !Number.isSafeInteger(update.update_id) ||
    (update.update_id as number) < 0
  ) {
    throw new TelegramUpdateProtocolError("invalid_update_id");
  }

  const typed = update as RecordUpdate;
  const updateId = typed.update_id;
  const presentFields = UPDATE_BODY_FIELDS.filter((field) => typed[field] !== undefined);
  if (presentFields.length > 1) {
    return malformed(updateId, "multiple_update_bodies");
  }

  if (typed.callback_query !== undefined) {
    const callback = typed.callback_query;
    if (
      !isRecord(callback) ||
      typeof callback.id !== "string" ||
      !callback.id
    ) {
      return malformed(updateId, "invalid_callback_query");
    }
    const data = callback.data;
    if (typeof data === "string" && data.startsWith("aud:")) {
      return { updateId, kind: "public_feedback", terminal: false };
    }
    if (
      typeof data === "string" &&
      ["lab:", "cfg:", "news:"].some((prefix) => data.startsWith(prefix))
    ) {
      return { updateId, kind: "admin_callback", terminal: false };
    }
    return { updateId, kind: "ignored_callback", terminal: false };
  }

  if (typed.message_reaction_count !== undefined) {
    const reaction = typed.message_reaction_count;
    if (
      !isRecord(reaction) ||
      !isRecord((reaction as { chat?: unknown }).chat) ||
      !Number.isSafeInteger((reaction as { chat: { id?: number } }).chat.id) ||
      !Number.isSafeInteger((reaction as { message_id?: number }).message_id) ||
      !Number.isSafeInteger((reaction as { date?: number }).date) ||
      !Array.isArray((reaction as { reactions?: unknown }).reactions)
    ) {
      return malformed(updateId, "invalid_reaction_count");
    }
    return { updateId, kind: "aggregate_reaction", terminal: false };
  }

  if (typed.message_reaction !== undefined) {
    return isRecord(typed.message_reaction)
      ? { updateId, kind: "ignored_individual_reaction", terminal: false }
      : malformed(updateId, "invalid_individual_reaction");
  }

  if (typed.message !== undefined) {
    return isRecord(typed.message)
      ? { updateId, kind: "message", terminal: false }
      : malformed(updateId, "invalid_message");
  }

  return { updateId, kind: "ignored", terminal: false };
}

function classifyUpdateError(error: unknown): {
  terminal: boolean;
  busy: boolean;
  errorCode: string;
} {
  if (error instanceof TelegramControlError && error.code === "update_in_progress") {
    return {
      busy: true,
      terminal: false,
      errorCode: error.code,
    };
  }
  if (
    error instanceof NonRetryableTelegramUpdateError ||
    (error as { retryable?: boolean })?.retryable === false
  ) {
    return {
      busy: false,
      terminal: true,
      errorCode: sanitizeErrorCode((error as { code?: string })?.code, "non_retryable_update"),
    };
  }
  return {
    busy: false,
    terminal: false,
    errorCode:
      error instanceof TelegramControlError && isTerminalTelegramControlError(error)
        ? error.code
        : "update_handler_failed",
  };
}

function isTelegramConflict(error: unknown): boolean {
  return (
    error instanceof TelegramError &&
    (error.status === 409 || error.errorCode === 409)
  );
}

export function retryDelay(attempt: number, random = Math.random): number {
  const ceiling = Math.min(
    TELEGRAM_CONTROL_POLLER_MAX_BACKOFF_MS,
    500 * 2 ** Math.min(attempt, 6),
  );
  return Math.floor(random() * ceiling);
}

export async function pollTelegramUpdates(options: {
  token: string;
  leaseName: string;
  ownerId: string;
  updates: TelegramUpdatesPersistence;
  transport: TelegramControlTransport;
  callTelegram: TelegramCallGateway;
  leaseApplication: PipelineLeaseApplicationPort;
  signal: AbortSignal;
  random?: () => number;
  sleepImpl?: (
    delayMs: number,
    _value?: unknown,
    opts?: { signal?: AbortSignal },
  ) => Promise<unknown>;
  log?: TelegramPollerLog;
  heartbeatIntervalMs?: number;
  leaseAcquireTimeoutMs?: number;
  leaseAcquireRetryMs?: number;
  nowImpl?: () => number;
  maxUpdateAttempts?: number;
  maxFailureLedgerAttempts?: number;
  onReady?: () => void;
}): Promise<void> {
  const {
    token,
    leaseName,
    ownerId,
    updates,
    transport,
    callTelegram,
    leaseApplication,
    signal,
    random = Math.random,
    sleepImpl = sleep,
    log,
    heartbeatIntervalMs = TELEGRAM_CONTROL_POLLER_HEARTBEAT_INTERVAL_MS,
    leaseAcquireTimeoutMs = TELEGRAM_CONTROL_POLLER_ACQUIRE_TIMEOUT_MS,
    leaseAcquireRetryMs = TELEGRAM_CONTROL_POLLER_ACQUIRE_RETRY_MS,
    nowImpl = Date.now,
    maxUpdateAttempts = TELEGRAM_CONTROL_POLLER_MAX_UPDATE_ATTEMPTS,
    maxFailureLedgerAttempts = TELEGRAM_CONTROL_POLLER_MAX_FAILURE_LEDGER_ATTEMPTS,
    onReady,
  } = options;

  const acquireDeadline = nowImpl() + leaseAcquireTimeoutMs;
  let waitingLogged = false;

  while (!signal.aborted) {
    const leaseAcquired = await leaseApplication.acquire({
      name: leaseName,
      ownerId,
      ttlSeconds: TELEGRAM_CONTROL_POLLER_LEASE_TTL_SECONDS,
    });
    if (leaseAcquired) {
      if (signal.aborted) {
        await leaseApplication.release({ name: leaseName, ownerId });
        return;
      }
      break;
    }
    if (nowImpl() >= acquireDeadline) {
      throw new Error(
        "Another Telegram polling process still holds the database lease",
      );
    }
    if (!waitingLogged) {
      log?.warn?.(
        JSON.stringify({
          event: "telegram_polling_lease_wait",
          timeout_ms: leaseAcquireTimeoutMs,
        }),
      );
      waitingLogged = true;
    }
    try {
      await sleepImpl(leaseAcquireRetryMs, undefined, { signal });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
  }

  // A coordinator may already be draining while this worker is waiting for a
  // lease. In that case we have no ownership to release and must not start a
  // new long poll after the cancellation boundary.
  if (signal.aborted) {
    return;
  }

  const leaseController = new AbortController();
  const operationController = new AbortController();
  const abortOperation = () => operationController.abort(signal.reason);
  signal.addEventListener("abort", abortOperation, { once: true });
  let rejectLeaseLoss: (reason: unknown) => void = () => undefined;
  const leaseLoss = new Promise<never>((_, reject) => {
    rejectLeaseLoss = reject;
  });
  const heartbeat = (async () => {
    try {
      while (!leaseController.signal.aborted) {
        await sleepImpl(heartbeatIntervalMs, undefined, {
          signal: leaseController.signal,
        });
        if (
          !(await leaseApplication.renew({
            name: leaseName,
            ownerId,
            ttlSeconds: TELEGRAM_CONTROL_POLLER_LEASE_TTL_SECONDS,
          }))
        ) {
          throw new PollingLeaseLostError();
        }
      }
    } catch (error) {
      if (!leaseController.signal.aborted && !operationController.signal.aborted) {
        operationController.abort(error);
        rejectLeaseLoss(
          error instanceof PollingLeaseLostError
            ? error
            : new PollingLeaseLostError(),
        );
      }
    }
  })();

  onReady?.();

  let offset = 0;
  let pollAttempt = 0;
  let failureLedgerAttempt = 0;

  const safeClaim = async (request: {
    updateId: number;
    updateKind: string;
  }): Promise<boolean> => {
    const claimed = await updates.claimTelegramUpdate({
      updateId: request.updateId,
      updateKind: request.updateKind,
      staleAfterSeconds: TELEGRAM_CONTROL_POLLER_LEASE_TTL_SECONDS * 2,
    });
    if (claimed.claimed) {
      if (claimed.claim_token === null) {
        throw new TelegramUpdateProtocolError("missing_claim_token");
      }
      return await updates.finishTelegramUpdate({
        updateId: request.updateId,
        claimToken: claimed.claim_token,
        status: "completed",
      });
    }
    if (claimed.claim_status === "busy") {
      throw new NonRetryableTelegramUpdateError("update_in_progress");
    }
    return true;
  };

  try {
    while (!signal.aborted) {
      let updatesBatch: unknown;
      try {
        updatesBatch = await Promise.race([
          callTelegram(
            token,
            "getUpdates",
            {
              offset,
              timeout: 25,
              allowed_updates: ["message", "callback_query"],
            },
            { signal: operationController.signal },
          ),
          leaseLoss,
        ]);
      } catch (error) {
        if (error instanceof PollingLeaseLostError) throw error;
        if (isTelegramConflict(error)) throw error;
        if (signal.aborted) break;
        log?.error(
          JSON.stringify({
            event: "telegram_poll_retry",
            attempt: pollAttempt,
            error_code: "poll_failed",
          }),
        );
        await sleepImpl(retryDelay(pollAttempt++, random), undefined, { signal });
        continue;
      }

      if (!Array.isArray(updatesBatch)) {
        throw new TelegramUpdateProtocolError("updates_not_array");
      }
      pollAttempt = 0;

      let retryCurrentUpdate = false;
      for (const rawUpdate of updatesBatch) {
        if (signal.aborted) break;

        const classification = classifyTelegramUpdate(rawUpdate);
        let failure: { busy: boolean; terminal: boolean; errorCode: string } | null =
          classification.terminal
            ? {
                terminal: true,
                busy: false,
                errorCode: classification.errorCode as string,
              }
            : null;

        if (!failure) {
          try {
            const handled = await Promise.race([
              transport.handle(rawUpdate as TelegramControlRawUpdate, {
                signal: operationController.signal,
              }).then(
                (value) => value.handled,
              ),
              leaseLoss,
            ]);
            if (!handled) {
              const finished = await safeClaim({
                updateId: classification.updateId,
                updateKind: classification.kind,
              });
              if (!finished) {
                throw new TelegramControlError(
                  "update_in_progress",
                  "Telegram update claim was not finished",
                );
              }
            }
          } catch (error) {
            if (error instanceof PollingLeaseLostError || isTelegramConflict(error)) {
              throw error;
            }
            if (signal.aborted) break;
            if (
              error instanceof TelegramControlError &&
              isTerminalTelegramControlError(error)
            ) {
              failure = null;
              // The transport/application boundary has already made this
              // terminal outcome durable. Treat it as acknowledged locally so
              // the cursor can advance instead of redelivering it forever.
            }
            else {
              failure = classifyUpdateError(error);
            }
          }
        }

        if (failure?.busy) {
          log?.error?.(
            JSON.stringify({
              event: "telegram_update_busy",
              update_id: classification.updateId,
              update_kind: classification.kind,
              error_code: failure.errorCode,
            }),
          );
          await sleepImpl(retryDelay(0, random), undefined, { signal });
          retryCurrentUpdate = true;
          break;
        }

        if (!failure) {
          failureLedgerAttempt = 0;
          offset = Math.max(offset, classification.updateId + 1);
          continue;
        }

        let recorded: Awaited<ReturnType<typeof updates.recordTelegramUpdateFailure>>;
        try {
          recorded = await Promise.race([
            updates.recordTelegramUpdateFailure({
              updateId: classification.updateId,
              updateKind: classification.kind,
              errorCode: failure.errorCode,
              maxAttempts: maxUpdateAttempts,
              terminal: failure.terminal,
              claimToken: null,
            } satisfies RecordTelegramUpdateFailureInput),
            leaseLoss,
          ]);
          failureLedgerAttempt = 0;
        } catch (error) {
          if (error instanceof PollingLeaseLostError) throw error;
          if (signal.aborted) break;
          if (++failureLedgerAttempt >= maxFailureLedgerAttempts) {
            throw new TelegramUpdatePersistenceError();
          }
          log?.error?.(
            JSON.stringify({
              event: "telegram_update_failure_ledger_retry",
              update_id: classification.updateId,
              attempt: failureLedgerAttempt,
              error_code: "failure_ledger_unavailable",
            }),
          );
          await sleepImpl(
            retryDelay(failureLedgerAttempt - 1, random),
            undefined,
            { signal },
          );
          retryCurrentUpdate = true;
          break;
        }

        if (!recorded.recorded && recorded.failure_status === "processing") {
          log?.error(
            JSON.stringify({
              event: "telegram_update_busy",
              update_id: classification.updateId,
              update_kind: classification.kind,
              error_code: "claim_not_owned",
            }),
          );
          await sleepImpl(retryDelay(0, random), undefined, { signal });
          retryCurrentUpdate = true;
          break;
        }

        if (recorded.terminal) {
          log?.warn?.(
            JSON.stringify({
              event:
                recorded.failure_status === "quarantined"
                  ? "telegram_update_quarantined"
                  : "telegram_update_already_terminal",
              update_id: classification.updateId,
              update_kind: classification.kind,
              attempt_count: recorded.attempt_count,
              error_code: failure.errorCode,
            }),
          );
          offset = Math.max(offset, classification.updateId + 1);
          continue;
        }

        log?.error?.(
          JSON.stringify({
            event: "telegram_update_retry",
            update_id: classification.updateId,
            update_kind: classification.kind,
            attempt_count: recorded.attempt_count,
            error_code: failure.errorCode,
          }),
        );
        await sleepImpl(
          retryDelay(recorded.attempt_count - 1, random),
          undefined,
          { signal },
        );
        retryCurrentUpdate = true;
        break;
      }

      if (retryCurrentUpdate) {
        continue;
      }
    }
  } catch (error) {
    if (signal.aborted) return;
    throw error;
  } finally {
    signal.removeEventListener("abort", abortOperation);
    leaseController.abort();
    operationController.abort();
    try {
      await heartbeat;
    } catch (error) {
      if (!signal.aborted) {
        throw error;
      }
    } finally {
      await leaseApplication.release({
        name: leaseName,
        ownerId,
      });
    }
  }
}

export type TelegramPollingWorkerOptions = {
  token: string;
  ownerId?: string;
  callTelegram: TelegramCallGateway;
  transport: TelegramControlTransport;
  updates: TelegramUpdatesPersistence;
  leaseApplication: PipelineLeaseApplicationPort;
  config?: {
    heartbeatIntervalMs?: number;
    leaseAcquireTimeoutMs?: number;
    leaseAcquireRetryMs?: number;
    random?: () => number;
    nowImpl?: () => number;
    sleepImpl?: (
      delayMs: number,
      value?: unknown,
      options?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
};

type StartupLatch = {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
  get settled(): boolean;
};

const createStartupLatch = (): StartupLatch => {
  let resolvePromise!: () => void;
  let rejectPromise!: (error: unknown) => void;
  let isSettled = false;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = () => {
      if (!isSettled) {
        isSettled = true;
        resolve();
      }
    };
    rejectPromise = (error) => {
      if (!isSettled) {
        isSettled = true;
        reject(error);
      }
    };
  });
  return {
    promise,
    resolve: resolvePromise,
    reject: rejectPromise,
    get settled() {
      return isSettled;
    },
  };
};

export class TelegramPollingWorker implements RuntimeWorker {
  readonly name = "telegram-polling";

  private readonly ownerId: string;
  private currentStop: AbortController | null = null;
  private currentRun: Promise<void> | null = null;
  private startup: StartupLatch | null = null;
  private stopRequested = false;
  private backgroundFatal: unknown = null;
  private readonly leaseName = TELEGRAM_CONTROL_POLLER_LEASE_NAME;
  private readonly options: TelegramPollingWorkerOptions;

  constructor(options: TelegramPollingWorkerOptions) {
    this.options = options;
    this.ownerId = options.ownerId ?? randomUUID();
  }

  async start(
    shutdownSignal: AbortSignal,
    reportFatal?: (error: unknown) => Promise<void>,
  ): Promise<void> {
    if (this.currentRun !== null) {
      return this.startup?.promise;
    }
    if (this.stopRequested || shutdownSignal.aborted) {
      return;
    }
    const stopSignal = new AbortController();
    const abortFromHost = () => stopSignal.abort(shutdownSignal.reason);
    shutdownSignal.addEventListener("abort", abortFromHost, { once: true });

    const startup = createStartupLatch();
    this.startup = startup;
    this.currentStop = stopSignal;
    const run = pollTelegramUpdates({
      token: this.options.token,
      leaseName: this.leaseName,
      ownerId: this.ownerId,
      updates: this.options.updates,
      transport: this.options.transport,
      callTelegram: this.options.callTelegram,
      leaseApplication: this.options.leaseApplication,
      signal: stopSignal.signal,
      heartbeatIntervalMs: this.options.config?.heartbeatIntervalMs,
      leaseAcquireTimeoutMs: this.options.config?.leaseAcquireTimeoutMs,
      leaseAcquireRetryMs: this.options.config?.leaseAcquireRetryMs,
      nowImpl: this.options.config?.nowImpl,
      random: this.options.config?.random,
      sleepImpl: this.options.config?.sleepImpl,
      log: console,
      onReady: startup.resolve,
    });
    this.currentRun = run;
    void run.then(
      () => {
        startup.resolve();
      },
      (error: unknown) => {
        if (!startup.settled) {
          startup.reject(error);
          return;
        }
        if (!stopSignal.signal.aborted && !shutdownSignal.aborted) {
          this.backgroundFatal = error;
          void reportFatal?.(error);
        }
      },
    ).finally(() => {
      shutdownSignal.removeEventListener("abort", abortFromHost);
      if (this.currentRun === run) {
        this.currentRun = null;
        this.currentStop = null;
        this.startup = null;
      }
    });

    await startup.promise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.currentStop?.abort("runtime-stop");
    try {
      await this.currentRun;
    } catch (error) {
      if (error !== this.backgroundFatal) {
        throw error;
      }
    }
  }
}
