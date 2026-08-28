import type { AiProviderDescriptor } from "./provider-descriptor.contracts.js";
import { exaProviderDescriptor } from "./exa.provider.js";
import { geminiProviderDescriptor } from "./gemini.provider.js";
import { openaiProviderDescriptor } from "./openai.provider.js";

/**
 * The complete set of built-in AI providers. Adding a provider means writing
 * one descriptor file and appending it here — nothing else in src/ai/ needs
 * to change.
 */
export const BUILTIN_PROVIDER_DESCRIPTORS: readonly AiProviderDescriptor[] = [
  openaiProviderDescriptor,
  geminiProviderDescriptor,
  exaProviderDescriptor,
];

export { exaProviderDescriptor, geminiProviderDescriptor, openaiProviderDescriptor };
export type { AiProviderDescriptor, AiProviderTraits } from "./provider-descriptor.contracts.js";
