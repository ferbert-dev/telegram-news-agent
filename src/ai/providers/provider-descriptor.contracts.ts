import type { AiProviderOperation, AiProviderPort } from "../ai-provider.contracts.js";

export type AiProviderTraits = {
  /**
   * Quota exhaustion aborts the whole fallback cascade instead of falling
   * through to the next configured provider. Without this, a provider that
   * runs out of quota would silently fail over to a paid provider on every
   * call once its quota is spent.
   */
  haltsCascadeOnQuotaExhaustion?: boolean;
  /**
   * Operations for which this provider, when configured, is used
   * exclusively and never raced or replaced by another provider.
   */
  exclusiveOperations?: readonly AiProviderOperation[];
  /**
   * Operations that must never be deadline-raced or retried concurrently,
   * because a call that has started is billed whether or not it settles.
   */
  sequentialOperations?: readonly AiProviderOperation[];
  /** The provider implements a standalone connection probe. */
  supportsConnectionTest?: boolean;
  /**
   * Implemented only by the typed NestJS runtime, and deliberately absent from
   * the legacy JS runtime in src/*-provider.js.
   *
   * The drift guard in checks/application/ai-provider-registry.ts otherwise
   * requires every registry id to be a name the legacy runtime also accepts,
   * so that the two runtimes cannot silently disagree while both are live.
   * This flag is the sanctioned exception, not a hole in it: the guard asserts
   * that a provider carrying this flag is REJECTED by the legacy runtime, so
   * "typed-only" has to be true rather than merely claimed.
   *
   * Use it only for a provider that is part of the migration's target state.
   * Adding one to the legacy runtime grows the surface still to be ported.
   */
  typedRuntimeOnly?: boolean;
  /**
   * Excluded from the default provider order unless `configure()` returns
   * non-null for the current environment. Providers without this trait are
   * always in the default order, whether or not they end up configured.
   */
  includeInDefaultOrderOnlyIfConfigured?: boolean;
};

export type AiProviderDescriptor<TConfig = unknown, TClient = unknown> = {
  /** Stable identifier. Also the value used in AI_PROVIDER_ORDER and persisted
   *  as the `provider` column on ai_usage_events / ai_provider_attempts —
   *  never change an existing id. */
  id: string;
  /** Human-readable name for status/diagnostics surfaces. */
  displayName: string;
  /** Operations this provider actually implements. */
  capabilities: readonly AiProviderOperation[];
  /** Lower sorts first in the default (unconfigured AI_PROVIDER_ORDER) order. */
  defaultOrderRank: number;
  traits: AiProviderTraits;
  /** Reads env into a typed config, or null when the provider is not configured.
   *  Must never throw on absence — only on a present-but-invalid configuration. */
  configure(env: NodeJS.ProcessEnv): TConfig | null;
  /** Builds the underlying SDK client from a non-null config. */
  createClient(config: TConfig): TClient;
  /** Builds the AiProviderPort adapter from config and client. */
  createAdapter(config: TConfig, client: TClient): AiProviderPort | null;
};
