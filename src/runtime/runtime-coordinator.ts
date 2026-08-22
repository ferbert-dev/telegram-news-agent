export type RuntimeWorker = {
  readonly name: string;
  start(shutdownSignal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
};

export type RuntimeSignal = {
  on(signal: string, handler: (signal: string) => void): void;
  off(signal: string, handler: (signal: string) => void): void;
};

export type RuntimeDeadline = {
  readonly expired: Promise<Error>;
  cancel(): void;
};

export type RuntimeDeadlineFactory = (timeoutMs: number) => RuntimeDeadline;

type RuntimeCoordinatorOptions = {
  applicationClose?: () => Promise<void>;
  workers: readonly RuntimeWorker[];
  signalSource: RuntimeSignal;
  stopGracePeriodMs: number;
  onSecondSignal?: (signalName: string) => Promise<void> | void;
  deadlineFactory?: RuntimeDeadlineFactory;
};

type LifecycleState = "idle" | "starting" | "running" | "stopping" | "stopped";

type Deferred = {
  readonly promise: Promise<void>;
  resolve(): void;
  reject(error: unknown): void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

export const createRuntimeDeadline: RuntimeDeadlineFactory = (timeoutMs) => {
  let timeoutId: NodeJS.Timeout | undefined;
  const expired = new Promise<Error>((resolve) => {
    timeoutId = setTimeout(
      () => resolve(new Error("runtime shutdown grace period exceeded")),
      timeoutMs,
    );
  });
  return {
    expired,
    cancel: () => clearTimeout(timeoutId),
  };
};

const observe = (promise: Promise<unknown>): void => {
  void promise.catch(() => undefined);
};

export class RuntimeCoordinator {
  static readonly SIGNALS = ["SIGINT", "SIGTERM"] as const;

  private applicationClose: () => Promise<void>;
  private readonly workers: readonly RuntimeWorker[];
  private readonly signalSource: RuntimeSignal;
  private readonly stopGracePeriodMs: number;
  private readonly onSecondSignal: (signalName: string) => Promise<void> | void;
  private readonly deadlineFactory: RuntimeDeadlineFactory;

  private readonly abortController = new AbortController();
  private readonly attemptedWorkers: RuntimeWorker[] = [];
  private readonly signalHandlers = new Map<string, (signal: string) => void>();
  private state: LifecycleState = "idle";
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private applicationClosePromise: Promise<void> | null = null;
  private firstSignalReceived = false;
  private secondSignalHandled = false;
  private applicationCloseBound = false;
  private readonly unboundApplicationClose = async () => {
    throw new Error("RuntimeCoordinator has no bound application close callback");
  };
  private _fatalCause: unknown = null;

  constructor({
    applicationClose,
    workers,
    signalSource,
    stopGracePeriodMs,
    onSecondSignal,
    deadlineFactory = createRuntimeDeadline,
  }: RuntimeCoordinatorOptions) {
    this.applicationClose = applicationClose ?? this.unboundApplicationClose;
    this.workers = workers;
    this.signalSource = signalSource;
    this.stopGracePeriodMs = stopGracePeriodMs;
    this.onSecondSignal = onSecondSignal ?? (() => {});
    this.deadlineFactory = deadlineFactory;
    this.applicationCloseBound = applicationClose !== undefined;
  }

  get stopSignal(): AbortSignal {
    return this.abortController.signal;
  }

  get lifecycleState(): LifecycleState {
    return this.state;
  }

  get fatalCause(): unknown {
    return this._fatalCause;
  }

  bindApplicationClose(applicationClose: () => Promise<void>): void {
    if (this.state !== "idle") {
      throw new Error("RuntimeCoordinator can only bind close callback in idle state");
    }
    if (this.applicationCloseBound) {
      throw new Error("RuntimeCoordinator application close is already bound");
    }
    this.applicationClose = applicationClose;
    this.applicationCloseBound = true;
  }

  async start(): Promise<void> {
    if (this.state !== "idle") {
      return;
    }
    if (!this.applicationCloseBound && this.applicationClose === this.unboundApplicationClose) {
      throw new Error("RuntimeCoordinator start requires bound application close callback");
    }

    this.installSignalHandlers();
    this.state = "starting";
    const startPromise = this.startWorkers();
    this.startPromise = startPromise;
    observe(startPromise);

    try {
      await startPromise;
      if (this.state === "starting") {
        this.state = "running";
      }
    } catch (error) {
      try {
        await this.requestStop("startup failure");
      } catch {
        // Preserve the startup failure. Shutdown failures remain observable to stop callers.
      }
      throw error;
    }
  }

  close(): Promise<void> {
    return this.requestStop("programmatic close");
  }

  reportFatal(error: unknown): Promise<void> {
    if (this._fatalCause === null) {
      this._fatalCause = error;
    }
    return this.requestStop("worker fatal");
  }

  private requestStop(reason: string): Promise<void> {
    if (this.stopPromise !== null) {
      return this.stopPromise;
    }

    const deferred = createDeferred();
    this.stopPromise = deferred.promise;
    observe(deferred.promise);
    void this.stopAll(reason).then(deferred.resolve, deferred.reject);
    return deferred.promise;
  }

  private async startWorkers(): Promise<void> {
    for (const worker of this.workers) {
      if (this.stopSignal.aborted) {
        return;
      }
      this.attemptedWorkers.push(worker);
      const startPromise = Promise.resolve().then(() => worker.start(this.stopSignal));
      observe(startPromise);
      await startPromise;
      if (this.stopSignal.aborted) {
        return;
      }
    }
  }

  private async stopAll(reason: string): Promise<void> {
    this.state = "stopping";
    const deadline = this.deadlineFactory(this.stopGracePeriodMs);
    this.abortController.abort(reason);

    const stopPromises = this.invokeStopsInReverse([...this.attemptedWorkers]);
    const drains = [
      ...(this.startPromise === null ? [] : [this.startPromise]),
      ...stopPromises,
    ];
    const drainResult = Promise.allSettled(drains);
    const firstPhase = await Promise.race([
      drainResult.then((results) => ({ kind: "drained" as const, results })),
      deadline.expired.then((error) => ({ kind: "timeout" as const, error })),
    ]);

    const closePromise = this.closeApplicationOnce();
    const closeResult = await Promise.race([
      closePromise.then(
        () => ({ kind: "closed" as const }),
        (error: unknown) => ({ kind: "close-error" as const, error }),
      ),
      deadline.expired.then((error) => ({ kind: "timeout" as const, error })),
    ]);

    try {
      if (firstPhase.kind === "timeout") {
        throw firstPhase.error;
      }
      if (closeResult.kind === "timeout") {
        throw closeResult.error;
      }

      const drainErrors = firstPhase.results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (closeResult.kind === "close-error") {
        drainErrors.push(closeResult.error);
      }
      if (drainErrors.length === 1) {
        throw drainErrors[0];
      }
      if (drainErrors.length > 1) {
        throw new AggregateError(drainErrors, "runtime shutdown failed");
      }
    } finally {
      deadline.cancel();
      this.removeSignalHandlers();
      this.state = "stopped";
    }
  }

  private invokeStopsInReverse(workers: RuntimeWorker[]): Promise<void>[] {
    const stopPromises: Promise<void>[] = [];
    for (const worker of workers.reverse()) {
      let stopPromise: Promise<void>;
      try {
        stopPromise = Promise.resolve(worker.stop());
      } catch (error) {
        stopPromise = Promise.reject(error);
      }
      observe(stopPromise);
      stopPromises.push(stopPromise);
    }
    return stopPromises;
  }

  private closeApplicationOnce(): Promise<void> {
    if (this.applicationClosePromise === null) {
      try {
        this.applicationClosePromise = Promise.resolve(this.applicationClose());
      } catch (error) {
        this.applicationClosePromise = Promise.reject(error);
      }
      observe(this.applicationClosePromise);
    }
    return this.applicationClosePromise;
  }

  private installSignalHandlers(): void {
    if (this.signalHandlers.size > 0) {
      return;
    }

    for (const signal of RuntimeCoordinator.SIGNALS) {
      const handler = () => {
        if (this.state === "stopped") {
          return;
        }
        if (!this.firstSignalReceived) {
          this.firstSignalReceived = true;
          observe(this.requestStop(`runtime signal ${signal}`));
          return;
        }
        if (this.secondSignalHandled) {
          return;
        }
        this.secondSignalHandled = true;
        const escalation = Promise.resolve().then(() => this.onSecondSignal(signal));
        observe(escalation);
      };
      this.signalHandlers.set(signal, handler);
      this.signalSource.on(signal, handler);
    }
  }

  private removeSignalHandlers(): void {
    for (const [signal, handler] of this.signalHandlers) {
      this.signalSource.off(signal, handler);
    }
    this.signalHandlers.clear();
  }
}
