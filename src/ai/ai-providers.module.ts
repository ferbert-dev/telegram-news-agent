import "reflect-metadata";

import { Module, type DynamicModule, type Provider } from "@nestjs/common";

import { createGeminiClientAdapter } from "./ai-provider.adapters.js";
import { createFallbackAiProvider, getAiProviderOrder } from "./ai-provider-composition.js";
import type { AiProviderAttemptWriter, AiProviderLogger } from "./ai-provider.contracts.js";
import { AI_PROVIDER, AI_PROVIDER_ATTEMPT_WRITER, AI_PROVIDER_ENV, AI_PROVIDER_LOGGER, EXA_PROVIDER, EXA_SDK, GEMINI_CLIENT, GEMINI_PROVIDER, GEMINI_SDK, OPENAI_PROVIDER, OPENAI_SDK } from "./ai-provider.tokens.js";
import { BUILTIN_PROVIDER_DESCRIPTORS } from "./providers/index.js";
import type { AiProviderDescriptor } from "./providers/provider-descriptor.contracts.js";
import { assertValidDescriptors } from "./providers/provider-registry.js";

/**
 * Built-in providers keep their original, stable Symbols so existing DI
 * overrides (e.g. swapping GEMINI_SDK in tests) keep working unchanged. A
 * provider added later that isn't one of these three gets a fresh Symbol
 * generated per registration — no other file needs to change.
 */
const NAMED_SDK_TOKENS: Record<string, symbol> = { openai: OPENAI_SDK, gemini: GEMINI_SDK, exa: EXA_SDK };
const NAMED_ADAPTER_TOKENS: Record<string, symbol> = { openai: OPENAI_PROVIDER, gemini: GEMINI_PROVIDER, exa: EXA_PROVIDER };

@Module({})
export class AiProvidersModule {
  static register({
    env = process.env,
    attemptRepository = null,
    log = console,
    descriptors = BUILTIN_PROVIDER_DESCRIPTORS,
  }: {
    env?: NodeJS.ProcessEnv;
    attemptRepository?: AiProviderAttemptWriter | null;
    log?: AiProviderLogger;
    descriptors?: readonly AiProviderDescriptor[];
  } = {}): DynamicModule {
    // Two descriptors sharing an id would silently collide on the same
    // NAMED_SDK_TOKENS/NAMED_ADAPTER_TOKENS Symbol below (Nest lets a later
    // `providers` entry for the same token win with no error) — fail loudly
    // instead.
    assertValidDescriptors(descriptors);

    const perProviderProviders: Provider[] = [];
    const adapterTokens: symbol[] = [];
    const adapterIds: string[] = [];

    for (const descriptor of descriptors) {
      const sdkToken = NAMED_SDK_TOKENS[descriptor.id] ?? Symbol(`AI_PROVIDER_SDK_${descriptor.id}`);
      const adapterToken = NAMED_ADAPTER_TOKENS[descriptor.id] ?? Symbol(`AI_PROVIDER_ADAPTER_${descriptor.id}`);
      adapterTokens.push(adapterToken);
      adapterIds.push(descriptor.id);

      perProviderProviders.push(
        {
          provide: sdkToken,
          inject: [AI_PROVIDER_ENV],
          useFactory: (settings: NodeJS.ProcessEnv) => {
            const config = descriptor.configure(settings);
            return config ? descriptor.createClient(config) : null;
          },
        },
        {
          provide: adapterToken,
          inject: [AI_PROVIDER_ENV, sdkToken],
          useFactory: (settings: NodeJS.ProcessEnv, client: unknown) => {
            const config = descriptor.configure(settings);
            return config ? descriptor.createAdapter(config, client) : null;
          },
        },
      );
    }

    return {
      module: AiProvidersModule,
      providers: [
        { provide: AI_PROVIDER_ENV, useValue: env },
        { provide: AI_PROVIDER_ATTEMPT_WRITER, useValue: attemptRepository },
        { provide: AI_PROVIDER_LOGGER, useValue: log },
        ...perProviderProviders,
        {
          provide: GEMINI_CLIENT,
          inject: [AI_PROVIDER_ENV, GEMINI_SDK],
          useFactory: (settings: NodeJS.ProcessEnv, sdk: unknown) =>
            settings.GEMINI_API_KEY?.trim() ? createGeminiClientAdapter(settings, sdk) : null,
        },
        {
          provide: AI_PROVIDER,
          inject: [AI_PROVIDER_ENV, AI_PROVIDER_LOGGER, AI_PROVIDER_ATTEMPT_WRITER, ...adapterTokens],
          useFactory: (
            settings: NodeJS.ProcessEnv,
            logger: AiProviderLogger,
            attempts: AiProviderAttemptWriter | null,
            ...adapters: unknown[]
          ) => {
            const byId = new Map(adapterIds.map((id, index) => [id, adapters[index]]));
            const order = getAiProviderOrder(settings, descriptors);
            return createFallbackAiProvider(
              order.map((id) => byId.get(id)) as never,
              { log: logger, attemptRepository: attempts, descriptors },
            );
          },
        },
      ],
      exports: [AI_PROVIDER, OPENAI_PROVIDER, GEMINI_PROVIDER, EXA_PROVIDER, GEMINI_CLIENT],
    };
  }
}
