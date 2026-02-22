#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * One-time migration: JsonVectorStore (memory.json) → LanceVectorStore (LanceDB).
 *
 * Run manually before first launch with LanceDB:
 *   npx tsx src/scripts/migrate-memory-to-lance.ts
 *
 * Idempotent: if Lance table has data, prompts to confirm wipe + re-migrate.
 * On failure: just re-run (it wipes and starts fresh).
 */

import { resolve } from 'node:path';
import { unlink, access } from 'node:fs/promises';
import * as readline from 'node:readline';
import { createJSONStorage } from '../storage/json-storage.js';
import { createEmbedder } from '../storage/embedder.js';
import { LanceVectorStore } from '../storage/lance-vector-store.js';
import type { MemoryEntry } from '../layers/cognition/tools/registry.js';
import type { Logger } from '../types/logger.js';

// ─── Config ───────────────────────────────────────────────────────────────────

const DATA_DIR = resolve('data');
const STATE_DIR = resolve(DATA_DIR, 'state');
const MEMORY_JSON = resolve(STATE_DIR, 'memory.json');
const LANCE_DB_PATH = resolve(STATE_DIR, 'memory', 'vector');
const MODEL_CACHE = resolve(DATA_DIR, 'models');
const BATCH_SIZE = 32;
const LOG_INTERVAL = 200;

// ─── Stored format (mirrors vector-store.ts) ─────────────────────────────────

interface MemoryStore {
  version: number;
  entries: StoredEntry[];
}

interface StoredEntry {
  id: string;
  type: 'message' | 'thought' | 'fact' | 'intention';
  content: string;
  timestamp: string;
  recipientId?: string | undefined;
  tags?: string[] | undefined;
  confidence?: number | undefined;
  salience?: number | undefined;
  metadata?: Record<string, unknown> | undefined;
  tickId?: string | undefined;
  parentSignalId?: string | undefined;
  trigger?: { condition: string; keywords?: string[] | undefined } | undefined;
  status?: 'pending' | 'completed' | undefined;
  expiresAt?: string | undefined;
}

function fromStored(e: StoredEntry): MemoryEntry {
  const entry: MemoryEntry & { salience?: number } = {
    id: e.id,
    type: e.type,
    content: e.content,
    timestamp: new Date(e.timestamp),
    recipientId: e.recipientId,
    tags: e.tags,
    confidence: e.confidence,
    metadata: e.metadata,
    tickId: e.tickId,
    parentSignalId: e.parentSignalId,
    trigger: e.trigger as MemoryEntry['trigger'],
    status: e.status,
    expiresAt: e.expiresAt ? new Date(e.expiresAt) : undefined,
  };
  if (e.salience != null) entry.salience = e.salience;
  return entry;
}

// ─── Logger stub ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-empty-function
const noop = () => {};
const logger: Logger = {
  child: () => logger,
  info: (_obj: unknown, msg?: string) => {
    if (msg) console.log(msg);
  },
  debug: noop,
  warn: (_obj: unknown, msg?: string) => {
    if (msg) console.warn(msg);
  },
  error: (_obj: unknown, msg?: string) => {
    if (msg) console.error(msg);
  },
  trace: noop,
  fatal: (_obj: unknown, msg?: string) => {
    if (msg) console.error(msg);
  },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => {
    rl.question(`${question} (y/N) `, (answer) => {
      rl.close();
      res(answer.toLowerCase() === 'y');
    });
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Memory Migration: JSON → LanceDB ===\n');

  // 1. Check source exists
  if (!(await fileExists(MEMORY_JSON))) {
    console.log(`Source file not found: ${MEMORY_JSON}`);
    console.log('Nothing to migrate.');
    process.exit(0);
  }

  // 2. Load source data
  console.log('Loading memory.json...');
  const storage = createJSONStorage(STATE_DIR);
  const data = (await storage.load('memory')) as MemoryStore | null;

  if (!data?.entries || data.entries.length === 0) {
    console.log('No entries found in memory.json. Nothing to migrate.');
    process.exit(0);
  }

  const entries = data.entries.map(fromStored);
  console.log(`Found ${String(entries.length)} entries to migrate.`);

  // 3. Check if Lance already has data
  const embedder = createEmbedder({ cacheDir: MODEL_CACHE });
  const vectorStore = new LanceVectorStore(logger, {
    dbPath: LANCE_DB_PATH,
    embedder,
    maxEntries: 100000, // No pruning during migration
  });

  const existingCount = await vectorStore.count();
  if (existingCount > 0) {
    console.log(`\nLanceDB table already has ${String(existingCount)} entries.`);
    const ok = await confirm('Wipe and re-migrate?');
    if (!ok) {
      console.log('Aborted.');
      process.exit(1);
    }
    await vectorStore.clear();
    console.log('Cleared existing LanceDB data.');
  }

  // 4. Embed and insert in batches
  console.log(
    `\nEmbedding and inserting ${String(entries.length)} entries (batch size: ${String(BATCH_SIZE)})...`
  );
  const startTime = Date.now();
  let migrated = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const texts = batch.map((e) => e.content);
    const vectors = await embedder.embedBatch(texts);

    await vectorStore.bulkImport(batch, vectors);
    migrated += batch.length;

    if (migrated % LOG_INTERVAL === 0 || migrated === entries.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (migrated / ((Date.now() - startTime) / 1000)).toFixed(0);
      console.log(
        `  ${String(migrated)}/${String(entries.length)} entries (${elapsed}s, ~${rate}/sec)`
      );
    }
  }

  // 5. Validate
  const finalCount = await vectorStore.count();
  if (finalCount !== entries.length) {
    console.error(
      `\nValidation FAILED: expected ${String(entries.length)}, got ${String(finalCount)}`
    );
    process.exit(1);
  }

  // 6. Remove memory.json
  await unlink(MEMORY_JSON);
  // Also remove backup if it exists
  try {
    await unlink(MEMORY_JSON + '.bak');
  } catch {
    // No backup to remove
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\nMigration complete: ${String(migrated)} entries migrated in ${totalTime}s. memory.json removed.`
  );
}

main().catch((err: unknown) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
