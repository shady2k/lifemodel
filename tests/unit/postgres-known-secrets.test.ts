import { describe, expect, it } from 'vitest';
import { parse } from 'pg-connection-string';
import { postgresKnownSecrets } from '../../src/storage/postgres-known-secrets.js';

describe('Postgres known secrets', () => {
  it.each([
    ['literal percent', 'postgres://core:ab%zz@database.invalid/core', 'ab%zz'],
    ['socket URL', 'postgres://core:socket-canary@/core?host=/run/postgresql', 'socket-canary'],
    ['socket path', '/run/postgresql core', undefined],
  ])('does not throw for the pg-supported %s form', (_name, databaseUrl, password) => {
    expect(() => postgresKnownSecrets(databaseUrl)).not.toThrow();
    const secrets = postgresKnownSecrets(databaseUrl);
    expect(parse(databaseUrl).password).toBe(password);
    expect(secrets).toContain(databaseUrl);
    if (password) expect(secrets).toContain(password);
    else expect(secrets).toEqual([databaseUrl]);
  });

  it('returns only the original URL when parsing fails, without exposing a startup error', () => {
    const databaseUrl = 'postgres://core:malformed-canary@[invalid/core';
    expect(() => postgresKnownSecrets(databaseUrl)).not.toThrow();
    expect(postgresKnownSecrets(databaseUrl)).toEqual([databaseUrl]);
  });

  it.each(['core', 'core:userinfo-canary'])(
    'includes the query password for %s, overriding userinfo when present',
    (userinfo) => {
      const databaseUrl = `postgres://${userinfo}@database.invalid/core?password=query%2Fcanary%3Aabcdef`;
      const password = 'query/canary:abcdef';
      expect(parse(databaseUrl).password).toBe(password);
      expect(postgresKnownSecrets(databaseUrl)).toContain(password);
    }
  );
});
