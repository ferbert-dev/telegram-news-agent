/**
 * Several application modules take their collaborators as *instances* at
 * module-definition time — `SchedulerApplicationModule.register({ editorial })`,
 * `TelegramControlApplicationModule.register({ editorial })`,
 * `EditorialApplicationModule.register({ draft })`. But those collaborators are
 * Nest-managed singletons that only exist once the container has been built:
 * `EditorialWorkflowService` lives inside `EditorialApplicationModule`,
 * `PipelineLeaseService` inside `OperationsApplicationModule`, and the legacy
 * draft gateway needs `LEGACY_PERSISTENCE`, which is itself assembled from
 * fifteen injected repositories.
 *
 * That is circular under the current signatures, and it is the same shape of
 * problem the runtime workers had. The workers were fixed by resolving them
 * from DI (`RuntimeModule.workerTokens`). That fix does not apply here, because
 * these values are consumed by a `register()` call rather than by an `inject`
 * array.
 *
 * The alternative would be adding a token-accepting variant to all three
 * modules' public `register()` shape. This keeps those APIs untouched instead:
 * hand `register()` a stand-in now, and point it at the real singleton the
 * moment the container finishes wiring.
 *
 * Ordering is what makes this safe rather than clever. `bootstrapRuntime`
 * awaits `NestFactory.createApplicationContext(...)` — which runs every
 * `onModuleInit` — strictly before it calls `coordinator.start()`. So a binder
 * provider that fills these in `onModuleInit` is guaranteed to have run before
 * any worker exists, let alone does work. An unbound call throws with the
 * port's name rather than returning undefined, so a wiring mistake surfaces
 * immediately instead of as a confusing downstream failure.
 */
export type LateBoundPort<T extends object> = {
  /** Pass this to `register()`. Forwards every method to the bound target. */
  readonly port: T;
  /** Point it at the real singleton. Called once, from `onModuleInit`. */
  bind(target: T): void;
  readonly isBound: boolean;
};

/**
 * Properties Nest reads to *inspect* a provider rather than to use it: the
 * thenable check while resolving, and every lifecycle-hook name, which it
 * probes on every provider during init. Answering these with undefined is also
 * semantically right -- a late-bound port must not claim lifecycle hooks, since
 * the binder and the runtime coordinator own that.
 */
const PROBE_PROPERTIES = new Set(["then", "constructor", "inspect", "toJSON"]);

/**
 * Nest probes every provider instance for these during init and close. A port
 * must never claim them -- in either state. While unbound, answering would be
 * a false positive; once bound, forwarding would let `app.close()` invoke the
 * real singleton's hook once per proxy pointed at it, on top of the singleton's
 * own invocation. `editorialWorkflow.port` alone is registered under two
 * tokens, so that would be three calls.
 */
const LIFECYCLE_HOOKS = new Set([
  "onModuleInit",
  "onModuleDestroy",
  "onApplicationBootstrap",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

function buildLateBoundPort<T extends object>(name: string): LateBoundPort<T> {
  let target: T | null = null;

  const port = new Proxy({} as T, {
    get(_unused, property) {
      if (typeof property === "string" && LIFECYCLE_HOOKS.has(property)) {
        return undefined;
      }
      if (target === null) {
        // Nest probes a useValue provider while resolving it -- notably
        // reading `then` to decide whether it is a promise -- which happens
        // before onModuleInit and must not look like misuse. Answer probes
        // with undefined; throw only for a real property access.
        if (typeof property === "symbol" || PROBE_PROPERTIES.has(property)) {
          return undefined;
        }
        throw new Error(
          `Late-bound port "${name}" was used before the container finished wiring it`,
        );
      }
      const value = Reflect.get(target as object, property) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
    // `has` must work unbound: some consumers feature-detect a method with
    // `in` before the first call, and throwing there would be a false negative
    // about the port's shape rather than a real wiring error.
    has(_unused, property) {
      if (typeof property === "string" && LIFECYCLE_HOOKS.has(property)) {
        return false;
      }
      return target === null ? false : Reflect.has(target as object, property);
    },
  });

  const handle: LateBoundPort<T> = {
    port,
    bind(next: T) {
      if (target !== null) {
        throw new Error(`Late-bound port "${name}" is already bound`);
      }
      target = next;
    },
    get isBound() {
      return target !== null;
    },
  };
  return handle;
}

/**
 * Creates every late-bound port a composition uses, and refuses a composition
 * that left one unbound.
 *
 * Creation lives here, and only here, on purpose. The first version of this
 * rule took a hand-written list, which closed one silent failure and left the
 * same one open a level up: a *new* port added without a matching entry was
 * silent again. The second version registered ports at creation but left the
 * registry argument optional and guarded it with an expected-count assertion --
 * which is silent in exactly the case it was written for, because a port
 * created without a registry does not change the count. A hand-maintained list
 * had become a hand-maintained count.
 *
 * There is now no way to construct a port outside a registry, so there is
 * nothing left to remember.
 */
export class LateBoundPortRegistry {
  private readonly ports: { name: string; port: LateBoundPort<object> }[] = [];

  create<T extends object>(name: string): LateBoundPort<T> {
    const handle = buildLateBoundPort<T>(name);
    this.ports.push({ name, port: handle as LateBoundPort<object> });
    return handle;
  }

  /** Every port this registry created that is still unbound. */
  unbound(): string[] {
    return this.ports.filter(({ port }) => !port.isBound).map(({ name }) => name);
  }

  /**
   * Refuses a composition that left a port unbound.
   *
   * A method rather than an inline check in the binder so the rule itself is
   * testable: the failure it prevents is silent, and a check that can only
   * observe fully-correct wiring cannot tell you the rule is still there.
   */
  assertAllBound(): void {
    const unbound = this.unbound();
    if (unbound.length > 0) {
      throw new Error(`Runtime composition left late-bound ports unbound: ${unbound.join(", ")}`);
    }
  }
}
