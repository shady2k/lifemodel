/**
 * Unit tests for Credential Store: env-var based store and credential resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createEnvCredentialStore,
  resolveCredentials,
  hasCredentialPlaceholders,
  credentialToStoreKey,
  credentialToRuntimeKey,
} from '../../../src/runtime/vault/credential-store.js';

describe('createEnvCredentialStore', () => {
  const store = createEnvCredentialStore();

  beforeEach(() => {
    // Clean up test env vars
    delete process.env['VAULT_TEST_KEY'];
    delete process.env['VAULT_API_KEY'];
  });

  afterEach(() => {
    delete process.env['VAULT_TEST_KEY'];
    delete process.env['VAULT_API_KEY'];
  });

  it('gets credential from env var', () => {
    process.env['VAULT_TEST_KEY'] = 'secret123';
    expect(store.get('test_key')).toBe('secret123');
  });

  it('returns null for missing credential', () => {
    expect(store.get('nonexistent')).toBeNull();
  });

  it('sets credential as env var', () => {
    store.set('api_key', 'abc123');
    expect(process.env['VAULT_API_KEY']).toBe('abc123');
  });

  it('deletes credential', () => {
    process.env['VAULT_TEST_KEY'] = 'value';
    expect(store.delete('test_key')).toBe(true);
    expect(process.env['VAULT_TEST_KEY']).toBeUndefined();
  });

  it('returns false when deleting non-existent credential', () => {
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('lists credential names', () => {
    process.env['VAULT_TEST_KEY'] = 'a';
    process.env['VAULT_API_KEY'] = 'b';
    const names = store.list();
    expect(names).toContain('test_key');
    expect(names).toContain('api_key');
  });
});

describe('resolveCredentials', () => {
  const store = createEnvCredentialStore();

  beforeEach(() => {
    process.env['VAULT_API_KEY'] = 'sk-secret-123';
    delete process.env['VAULT_MISSING'];
  });

  afterEach(() => {
    delete process.env['VAULT_API_KEY'];
  });

  it('resolves credential placeholders', () => {
    const { resolved, missing } = resolveCredentials(
      'curl -H "Authorization: Bearer <credential:api_key>" https://api.example.com',
      store
    );
    expect(resolved).toContain('sk-secret-123');
    expect(resolved).not.toContain('<credential:');
    expect(missing).toEqual([]);
  });

  it('leaves missing placeholders and reports them', () => {
    const { resolved, missing } = resolveCredentials(
      'curl -H "Authorization: <credential:missing>" https://api.example.com',
      store
    );
    expect(resolved).toContain('<credential:missing>');
    expect(missing).toEqual(['missing']);
  });

  it('resolves multiple placeholders', () => {
    process.env['VAULT_TOKEN'] = 'tok-abc';
    const { resolved, missing } = resolveCredentials(
      '<credential:api_key> and <credential:token>',
      store
    );
    expect(resolved).toBe('sk-secret-123 and tok-abc');
    expect(missing).toEqual([]);
    delete process.env['VAULT_TOKEN'];
  });

  it('handles text without placeholders', () => {
    const { resolved, missing } = resolveCredentials('no credentials here', store);
    expect(resolved).toBe('no credentials here');
    expect(missing).toEqual([]);
  });

  it('resolves $NAME env var references for known credentials', () => {
    const { resolved, missing } = resolveCredentials(
      'curl -H "Authorization: Bearer $API_KEY" https://api.example.com',
      store
    );
    expect(resolved).toContain('sk-secret-123');
    expect(resolved).not.toContain('$API_KEY');
    expect(missing).toEqual([]);
  });

  it('resolves ${NAME} env var references for known credentials', () => {
    const { resolved, missing } = resolveCredentials(
      'curl -H "Authorization: Bearer ${API_KEY}" https://api.example.com',
      store
    );
    expect(resolved).toContain('sk-secret-123');
    expect(resolved).not.toContain('${API_KEY}');
    expect(missing).toEqual([]);
  });

  it('leaves $NAME for unknown (non-credential) env vars', () => {
    const { resolved, missing } = resolveCredentials(
      'echo $HOME and $PATH',
      store
    );
    expect(resolved).toBe('echo $HOME and $PATH');
    expect(missing).toEqual([]);
  });

  it('resolves mixed placeholder and env var styles', () => {
    const { resolved } = resolveCredentials(
      '<credential:api_key> and $API_KEY',
      store
    );
    expect(resolved).toBe('sk-secret-123 and sk-secret-123');
  });
});

describe('credentialToStoreKey', () => {
  it('maps credential name to VAULT_ env var', () => {
    expect(credentialToStoreKey('api_key')).toBe('VAULT_API_KEY');
  });

  it('uppercases the name', () => {
    expect(credentialToStoreKey('mySecret')).toBe('VAULT_MYSECRET');
  });

  it('handles already-uppercase names', () => {
    expect(credentialToStoreKey('TOKEN')).toBe('VAULT_TOKEN');
  });
});

describe('credentialToRuntimeKey', () => {
  it('maps credential name to plain uppercase env var', () => {
    expect(credentialToRuntimeKey('api_key')).toBe('API_KEY');
  });

  it('uppercases mixed-case names', () => {
    expect(credentialToRuntimeKey('mySecret')).toBe('MYSECRET');
  });

  it('no VAULT_ prefix (container uses plain names)', () => {
    const key = credentialToRuntimeKey('token');
    expect(key).toBe('TOKEN');
    expect(key).not.toContain('VAULT');
  });
});

describe('hasCredentialPlaceholders', () => {
  it('detects placeholders', () => {
    expect(hasCredentialPlaceholders('use <credential:api_key> here')).toBe(true);
  });

  it('returns false when no placeholders', () => {
    expect(hasCredentialPlaceholders('no credentials here')).toBe(false);
  });
});
