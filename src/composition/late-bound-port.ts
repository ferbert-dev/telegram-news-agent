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
const PROBE_PROPERTIES = new Set([
  "then",
  "constructor",
  "inspect",
  "toJSON",
  "onModuleInit",
  "onModuleDestroy",
  "onApplicationBootstrap",
  "beforeApplicationShutdown",
  "onApplicationShutdown",
]);

export function createLateBoundPort<T extends object>(name: string): LateBoundPort<T> {
  let target: T | null = null;

  const port = new Proxy({} as T, {
    get(_unused, property) {
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
      return target === null ? false : Reflect.has(target as object, property);
    },
  });

  return {
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
}
