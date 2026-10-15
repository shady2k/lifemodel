import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type Redis from 'iovalkey';
import type { Pool } from 'pg';
import { existsSync } from 'node:fs';
import { createTestStores } from '../helpers/test-stores.js';

describe('isolated Valkey and pgvector stores', () => {
  let redis: Redis;
  let postgres: Pool;

  beforeAll(async () => {
    ({ redis, postgres } = await createTestStores());
  });

  afterAll(async () => {
    await Promise.all([redis?.quit(), postgres?.end()]);
  });

  it('has no Docker socket and cannot reach an outside address', async () => {
    expect(existsSync('/var/run/docker.sock')).toBe(false);
    await expect(fetch('http://1.1.1.1/', { signal: AbortSignal.timeout(2_000) })).rejects.toThrow();
  });

  it('isolates Valkey namespaces for distinct and reused worker ids', async () => {
    const first = await createTestStores('1');
    const distant = await createTestStores('17');
    try {
      await first.redis.set('collision-check', 'worker-1');
      expect(await distant.redis.get('collision-check')).toBeNull();
      const reused = await createTestStores('1');
      try {
        expect(await reused.redis.get('collision-check')).toBeNull();
      } finally {
        await Promise.all([reused.redis.quit(), reused.postgres.end()]);
      }
    } finally {
      await Promise.all([first.redis.quit(), first.postgres.end(), distant.redis.quit(), distant.postgres.end()]);
    }
  });

  it('evaluates Lua on Valkey', async () => {
    const result = await redis.eval('return tonumber(ARGV[1]) * 7', 0, '6');
    expect(result).toBe(42);
  });

  it('finds the nearest pgvector row', async () => {
    const client = await postgres.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query('CREATE TEMP TABLE embeddings (id integer, embedding vector(3))');
      await client.query('INSERT INTO embeddings VALUES (1, $1), (2, $2), (3, $3)', ['[1,0,0]', '[0,1,0]', '[0,0,1]']);
      const result = await client.query('SELECT id FROM embeddings ORDER BY embedding <-> $1 LIMIT 1', ['[0.9,0.1,0]']);
      expect(result.rows[0].id).toBe(1);
    } finally {
      client.release();
    }
  });
});
