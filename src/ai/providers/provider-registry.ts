import { BUILTIN_PROVIDER_DESCRIPTORS } from "./index.js";
import type { AiProviderDescriptor, AiProviderTraits } from "./provider-descriptor.contracts.js";

export function listProviderIds(
  descriptors: readonly AiProviderDescriptor[] = BUILTIN_PROVIDER_DESCRIPTORS,
): string[] {
  return descriptors.map((descriptor) => descriptor.id);
}

export function findDescriptor(
  id: string,
  descriptors: readonly AiProviderDescriptor[] = BUILTIN_PROVIDER_DESCRIPTORS,
): AiProviderDescriptor | undefined {
  return descriptors.find((descriptor) => descriptor.id === id);
}

export function traitsOf(
  providerId: string,
  descriptors: readonly AiProviderDescriptor[] = BUILTIN_PROVIDER_DESCRIPTORS,
): AiProviderTraits {
  return findDescriptor(providerId, descriptors)?.traits ?? {};
}

/**
 * Providers marked `includeInDefaultOrderOnlyIfConfigured` (e.g. Exa) only
 * appear in the default order when `configure(env)` resolves; every other
 * provider is always present, configured or not — unconfigured ones are
 * filtered out later, once the fallback cascade is actually built.
 */
export function getDefaultProviderOrder(
  env: NodeJS.ProcessEnv,
  descriptors: readonly AiProviderDescriptor[] = BUILTIN_PROVIDER_DESCRIPTORS,
): string[] {
  return [...descriptors]
    .filter(
      (descriptor) =>
        !descriptor.traits.includeInDefaultOrderOnlyIfConfigured
        || descriptor.configure(env) !== null,
    )
    .sort((a, b) => a.defaultOrderRank - b.defaultOrderRank)
    .map((descriptor) => descriptor.id);
}

export function assertValidDescriptors(descriptors: readonly AiProviderDescriptor[]): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (!descriptor.id) {
      throw new Error("AI provider descriptor is missing an id");
    }
    if (seen.has(descriptor.id)) {
      throw new Error(`Duplicate AI provider descriptor id: ${descriptor.id}`);
    }
    seen.add(descriptor.id);
    if (!descriptor.capabilities.length) {
      throw new Error(`AI provider descriptor "${descriptor.id}" declares no capabilities`);
    }
  }
}
