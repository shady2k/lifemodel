/**
 * The storage catalog check's vocabulary (ADR-015 S-D7).
 *
 * The module reports one reason code to Kubernetes and keeps the repair in its
 * own log. These checks pin which failure means which repair, and that the
 * login is built from the two secrets without adding anything to the URL.
 */
import { describe, expect, it } from 'vitest';
import {
  STORAGE_CATALOG_READ,
  STORAGE_DATABASE_TARGET,
  catalogCause,
  catalogConnectionString,
} from '../../loader/src/storage-catalog.js';

describe('the storage catalog failure causes', () => {
  it.each([
    ['28P01', 'auth_failed'],
    ['28000', 'auth_failed'],
    ['3D000', 'schema_missing'],
    ['3F000', 'schema_missing'],
    ['42P01', 'schema_missing'],
    ['42501', 'forbidden'],
    ['XX000', 'failed'],
    ['23505', 'failed'],
    ['ECONNREFUSED', 'unreachable'],
    ['ENOTFOUND', 'unreachable'],
    ['ETIMEDOUT', 'unreachable'],
  ] as const)('reads SQLSTATE %s and socket code %s as its repair', (code, cause) => {
    expect(catalogCause(Object.assign(new Error('failed'), { code }))).toBe(cause);
  });

  it('reads a failure with no code as an unreachable server', () => {
    expect(catalogCause(new Error('connection terminated'))).toBe('unreachable');
    expect(catalogCause(undefined)).toBe('unreachable');
    expect(catalogCause({ code: 42 })).toBe('unreachable');
  });
});

describe('the storage catalog login', () => {
  it('builds the login from the username and password alone', () => {
    expect(catalogConnectionString('lifemodel', 'p@ss word:/')).toBe(
      `postgresql://lifemodel:p%40ss%20word%3A%2F@${STORAGE_DATABASE_TARGET}`
    );
  });

  it('refuses a missing half of the login instead of connecting anonymously', () => {
    expect(() => catalogConnectionString('', 'secret')).toThrow(/username and a password/);
    expect(() => catalogConnectionString('lifemodel', '')).toThrow(/username and a password/);
  });

  it('reads a catalog table, so an empty catalog is ready and a missing one is not', () => {
    expect(STORAGE_CATALOG_READ).toContain('FROM storage.spaces');
    expect(STORAGE_CATALOG_READ.startsWith('SELECT')).toBe(true);
  });
});
