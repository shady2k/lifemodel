/**
 * Search Provider Registry
 *
 * Manages search provider discovery, priority, and instantiation.
 * Priority is configurable via SEARCH_PROVIDER_PRIORITY env var.
 *
 * Example: SEARCH_PROVIDER_PRIORITY=tavily,serper,brave
 */

import type { Logger } from '../../../types/logger.js';
import type { SearchProvider } from './search-provider.js';
import { SerperSearchProvider } from './serper-provider.js';
import { TavilySearchProvider } from './tavily-provider.js';
import { BraveSearchProvider } from './brave-provider.js';

// ═══════════════════════════════════════════════════════════════
// PROVIDER DESCRIPTORS
// ═══════════════════════════════════════════════════════════════

/**
 * Provider descriptor with metadata for discovery and instantiation.
 */
export interface ProviderDescriptor {
  /** Unique provider identifier */
  id: string;
  /** Human-readable name */
  displayName: string;
  /** Environment variables required for this provider */
  requiredEnv: string[];
  /** Factory function to create provider instance */
  factory: (logger: Logger) => SearchProvider;
}

/**
 * Built-in provider descriptors.
 * Order here is the default priority (first = highest).
 */
const PROVIDER_DESCRIPTORS: ProviderDescriptor[] = [
  {
    id: 'serper',
    displayName: 'Serper (Google)',
    requiredEnv: ['SERPER_API_KEY'],
    factory: (logger) => new SerperSearchProvider(logger),
  },
  {
    id: 'tavily',
    displayName: 'Tavily (AI-optimized)',
    requiredEnv: ['TAVILY_API_KEY'],
    factory: (logger) => new TavilySearchProvider(logger),
  },
  {
    id: 'brave',
    displayName: 'Brave Search',
    requiredEnv: ['BRAVE_API_KEY'],
    factory: (logger) => new BraveSearchProvider(logger),
  },
];

// ═══════════════════════════════════════════════════════════════
// REGISTRY
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a provider's required env vars are all set.
 */
function isProviderAvailable(descriptor: ProviderDescriptor): boolean {
  return descriptor.requiredEnv.every((envVar) => !!process.env[envVar]);
}

/**
 * Parse SEARCH_PROVIDER_PRIORITY env var.
 * Returns array of provider IDs or null if not set.
 */
function parsePriorityEnv(): string[] | null {
  const priorityEnv = process.env['SEARCH_PROVIDER_PRIORITY'];
  if (!priorityEnv) return null;

  return priorityEnv
    .split(',')
    .map((id) => id.trim().toLowerCase())
    .filter((id) => id.length > 0);
}

/**
 * Get ordered list of provider descriptors based on priority config.
 */
function getOrderedDescriptors(): ProviderDescriptor[] {
  const priorityList = parsePriorityEnv();

  if (!priorityList) {
    // No custom priority - use built-in order
    return PROVIDER_DESCRIPTORS;
  }

  const ordered: ProviderDescriptor[] = [];
  const seen = new Set<string>();

  // First, add providers in priority order
  for (const id of priorityList) {
    const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === id);
    if (descriptor && !seen.has(id)) {
      ordered.push(descriptor);
      seen.add(id);
    }
  }

  // Then, add any remaining providers not in priority list
  for (const descriptor of PROVIDER_DESCRIPTORS) {
    if (!seen.has(descriptor.id)) {
      ordered.push(descriptor);
      seen.add(descriptor.id);
    }
  }

  return ordered;
}

/**
 * Get all known provider IDs.
 */
export function getAllProviderIds(): string[] {
  return PROVIDER_DESCRIPTORS.map((d) => d.id);
}

/**
 * Get available providers (those with required env vars set).
 * Returns in priority order.
 */
export function getAvailableProviders(): ProviderDescriptor[] {
  return getOrderedDescriptors().filter(isProviderAvailable);
}

/**
 * Get the default provider ID (first available in priority order).
 * Returns null if no providers are available.
 */
export function getDefaultProviderId(): string | null {
  const available = getAvailableProviders();
  return available.length > 0 ? (available[0]?.id ?? null) : null;
}

/**
 * Check if a provider ID is valid (known).
 */
export function isValidProviderId(id: string): boolean {
  return PROVIDER_DESCRIPTORS.some((d) => d.id === id);
}

/**
 * Check if a specific provider is available.
 */
export function isProviderIdAvailable(id: string): boolean {
  const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === id);
  return descriptor ? isProviderAvailable(descriptor) : false;
}

/**
 * Get the required env var name for a provider.
 */
export function getProviderEnvVar(id: string): string | null {
  const descriptor = PROVIDER_DESCRIPTORS.find((d) => d.id === id);
  return descriptor?.requiredEnv[0] ?? null;
}

/**
 * Create provider instances for all available providers.
 * Returns a Map of provider ID to instance.
 */
export function createProviderInstances(logger: Logger): Map<string, SearchProvider> {
  const providers = new Map<string, SearchProvider>();

  for (const descriptor of getOrderedDescriptors()) {
    if (isProviderAvailable(descriptor)) {
      providers.set(descriptor.id, descriptor.factory(logger));
    }
  }

  return providers;
}

/**
 * Get health check info about provider availability.
 */
export function getProviderHealthInfo(): {
  available: string[];
  unavailable: { id: string; missingEnv: string }[];
  defaultProvider: string | null;
  configuredPriority: string[] | null;
} {
  const configuredPriority = parsePriorityEnv();
  const available: string[] = [];
  const unavailable: { id: string; missingEnv: string }[] = [];

  for (const descriptor of getOrderedDescriptors()) {
    if (isProviderAvailable(descriptor)) {
      available.push(descriptor.id);
    } else {
      unavailable.push({
        id: descriptor.id,
        missingEnv: descriptor.requiredEnv[0] ?? 'unknown',
      });
    }
  }

  return {
    available,
    unavailable,
    defaultProvider: getDefaultProviderId(),
    configuredPriority,
  };
}
