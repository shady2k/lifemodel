/**
 * Script Registry
 *
 * Static registry of available scripts. Each entry defines the Docker image,
 * entrypoint, domains, lock config, and I/O schemas for a script.
 *
 * Script ID namespace: <domain>.<resource>.<action>
 * Examples: news.telegram_group.fetch, news.telegram_group.list
 */

import { z } from 'zod';
import { BROWSER_IMAGE } from '../container/types.js';
import type { ScriptRegistryEntry } from './script-types.js';

// ─── Registry Entries ────────────────────────────────────────

const entries = new Map<string, ScriptRegistryEntry>();

/**
 * news.telegram_group.fetch — Fetch messages from a private Telegram group.
 * Uses browser profile for authentication. Runs headless Playwright.
 */
// Telegram Web A domains — wildcard covers all DC subdomains (pluto, venus, zws2, etc.)
// and WebSocket MTProto endpoints that the SPA discovers at runtime.
const TELEGRAM_DOMAINS = [
  'web.telegram.org',
  '*.web.telegram.org',
  'telegram.org',
  't.me',
  'telegram.me',
];

entries.set('news.telegram_group.fetch', {
  id: 'news.telegram_group.fetch',
  image: BROWSER_IMAGE,
  entrypoint: ['node', '/scripts/telegram-group-fetch.js'],
  domains: TELEGRAM_DOMAINS,
  maxTimeoutMs: 120_000,
  lock: {
    keyTemplate: 'browserProfile:${inputs.profile}',
    exclusive: true,
    waitPolicy: 'fail_fast',
    waitTimeoutMs: 0,
    leaseMs: 120_000,
  },
  profileVolume: {
    volumeNamePrefix: 'lifemodel-browser-profile',
    containerPath: '/profile',
    mode: 'rw',
  },
  inputSchema: z.object({
    profile: z.string(),
    groupUrl: z.url(),
    lastSeenId: z.string().optional(),
    maxMessages: z.number().int().positive().optional(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    messages: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        date: z.string(),
        from: z.string(),
      })
    ),
    latestId: z.string().nullable(),
  }),
});

/**
 * news.telegram_group.list — Discover groups/channels from an authenticated Telegram session.
 * Uses browser profile for authentication. Reads sidebar only (no writes).
 */
entries.set('news.telegram_group.list', {
  id: 'news.telegram_group.list',
  image: BROWSER_IMAGE,
  entrypoint: ['node', '/scripts/telegram-group-list.js'],
  domains: TELEGRAM_DOMAINS,
  maxTimeoutMs: 60_000,
  lock: {
    keyTemplate: 'browserProfile:${inputs.profile}',
    exclusive: true,
    waitPolicy: 'fail_fast',
    waitTimeoutMs: 0,
    leaseMs: 60_000,
  },
  profileVolume: {
    volumeNamePrefix: 'lifemodel-browser-profile',
    containerPath: '/profile',
    mode: 'rw', // Chromium needs write access for lock files and cache
  },
  inputSchema: z.object({
    profile: z.string(),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    groups: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        url: z.string(),
      })
    ),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
      })
      .optional(),
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
