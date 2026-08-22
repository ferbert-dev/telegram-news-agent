import "reflect-metadata";

import { Module, type DynamicModule } from "@nestjs/common";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { Exa } from "exa-js";
import { getExaProviderConfig } from "../exa-provider.js";

import { createExaProviderAdapter, createGeminiClientAdapter, createGeminiProviderAdapter, createOpenAiProviderAdapter } from "./ai-provider.adapters.js";
import { createFallbackAiProvider, getAiProviderOrder } from "./ai-provider-composition.js";
import type { AiProviderAttemptWriter, AiProviderLogger } from "./ai-provider.contracts.js";
import { AI_PROVIDER, AI_PROVIDER_ATTEMPT_WRITER, AI_PROVIDER_ENV, AI_PROVIDER_LOGGER, EXA_PROVIDER, EXA_SDK, GEMINI_CLIENT, GEMINI_PROVIDER, GEMINI_SDK, OPENAI_PROVIDER, OPENAI_SDK } from "./ai-provider.tokens.js";

@Module({})
export class AiProvidersModule {
  static register({ env = process.env, attemptRepository = null, log = console }: {
    env?: NodeJS.ProcessEnv;
    attemptRepository?: AiProviderAttemptWriter | null;
    log?: AiProviderLogger;
  } = {}): DynamicModule {
    return {
      module: AiProvidersModule,
      providers: [
        { provide: AI_PROVIDER_ENV, useValue: env },
        { provide: AI_PROVIDER_ATTEMPT_WRITER, useValue: attemptRepository },
        { provide: AI_PROVIDER_LOGGER, useValue: log },
        { provide: OPENAI_SDK, inject: [AI_PROVIDER_ENV], useFactory: (settings: NodeJS.ProcessEnv) => settings.OPENAI_API_KEY?.trim() ? new OpenAI({ apiKey: settings.OPENAI_API_KEY.trim() }) : null },
        { provide: GEMINI_SDK, inject: [AI_PROVIDER_ENV], useFactory: (settings: NodeJS.ProcessEnv) => settings.GEMINI_API_KEY?.trim() ? new GoogleGenAI({ apiKey: settings.GEMINI_API_KEY.trim() }) : null },
        { provide: EXA_SDK, inject: [AI_PROVIDER_ENV], useFactory: (settings: NodeJS.ProcessEnv) => {
          const config = getExaProviderConfig(settings);
          return config ? new Exa(config.apiKey) : null;
        } },
        { provide: GEMINI_CLIENT, inject: [AI_PROVIDER_ENV], useFactory: (settings: NodeJS.ProcessEnv) => settings.GEMINI_API_KEY?.trim() ? createGeminiClientAdapter(settings) : null },
        { provide: OPENAI_PROVIDER, inject: [AI_PROVIDER_ENV, OPENAI_SDK], useFactory: createOpenAiProviderAdapter },
        { provide: GEMINI_PROVIDER, inject: [AI_PROVIDER_ENV, GEMINI_SDK], useFactory: createGeminiProviderAdapter },
        { provide: EXA_PROVIDER, inject: [AI_PROVIDER_ENV, EXA_SDK], useFactory: createExaProviderAdapter },
        { provide: AI_PROVIDER, inject: [AI_PROVIDER_ENV, OPENAI_PROVIDER, GEMINI_PROVIDER, EXA_PROVIDER, AI_PROVIDER_LOGGER, AI_PROVIDER_ATTEMPT_WRITER], useFactory: (settings: NodeJS.ProcessEnv, openai: ReturnType<typeof createOpenAiProviderAdapter>, gemini: ReturnType<typeof createGeminiProviderAdapter>, exa: ReturnType<typeof createExaProviderAdapter>, logger: AiProviderLogger, attempts: AiProviderAttemptWriter | null) => {
          const providers = { openai, gemini, exa };
          return createFallbackAiProvider(getAiProviderOrder(settings).map((name) => providers[name as keyof typeof providers]), { log: logger, attemptRepository: attempts });
        } },
      ],
      exports: [AI_PROVIDER, OPENAI_PROVIDER, GEMINI_PROVIDER, EXA_PROVIDER, GEMINI_CLIENT],
    };
  }
}
