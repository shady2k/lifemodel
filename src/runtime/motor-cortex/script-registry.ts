/**
 * Script Registry
 *
 * Static registry of available scripts. Each entry defines the Docker image,
 * entrypoint, domains, lock config, and I/O schemas for a script.
 *
 * Script ID namespace: <domain>.<resource>.<action>
 * Examples: test.echo.run, news.telegram_group.fetch
 */

import { z } from 'zod';
import { CONTAINER_IMAGE } from '../container/types.js';
import type { ScriptRegistryEntry } from './script-types.js';

// ─── Registry Entries ────────────────────────────────────────

const entries = new Map<string, ScriptRegistryEntry>();

/**
 * test.echo.run — Phase 1 test script.
 * Reads SCRIPT_INPUTS, echoes { echo: inputs.message }.
 * Uses the existing motor image (no browser needed).
 */
entries.set('test.echo.run', {
  id: 'test.echo.run',
  image: CONTAINER_IMAGE,
  entrypoint: ['node', '/opt/motor/scripts/echo-test.js'],
  domains: [],
  maxTimeoutMs: 10_000,
  inputSchema: z.object({
    message: z.string(),
  }),
  outputSchema: z.object({
    echo: z.string(),
  }),
});

// ─── Public API ──────────────────────────────────────────────

/**
 * Get a script registry entry by ID.
 */
export function getScriptEntry(id: string): ScriptRegistryEntry | undefined {
  return entries.get(id);
}

/**
 * Get all registered script IDs.
 */
export function getAllScriptIds(): string[] {
  return Array.from(entries.keys());
}

/**
 * Register a script entry (used by later phases to add entries).
 */
export function registerScriptEntry(entry: ScriptRegistryEntry): void {
  entries.set(entry.id, entry);
}
