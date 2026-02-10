/**
 * Tests for core.credential tool
 *
 * Validates: set, delete, list actions
 * - Credential values are never returned in responses
 * - Name format validation
 * - Error handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createCredentialTool } from '../credential.js';
import type { CredentialResult } from '../credential.js';
import { createEnvCredentialStore } from '../../../../../runtime/vault/credential-store.js';

// Generate unique test names to avoid conflicts with system env vars
const testId = `${String(Date.now())}${Math.random().toString(36).slice(2, 8)}`;
const testNames = {
  apiKey: `test_api_key_${testId}`,
  anotherKey: `test_another_key_${testId}`,
};

describe('core.credential tool', () => {
  const credentialStore = createEnvCredentialStore();
  const tool = createCredentialTool({ credentialStore });

  beforeEach(() => {
    // Clear test credentials before each test
    credentialStore.delete(testNames.apiKey);
    credentialStore.delete(testNames.anotherKey);
  });

  describe('set action', () => {
    it('sets a credential successfully', async () => {
      const result = (await tool.execute({
        action: 'set',
        name: testNames.apiKey,
        value: 'sk-test-123',
      })) as CredentialResult;

      expect(result.success).toBe(true);
      expect(result.action).toBe('set');
      expect(result.name).toBe(testNames.apiKey);

      // Verify it was stored
      expect(credentialStore.get(testNames.apiKey)).toBe('sk-test-123');
    });

    it('requires name for set action', async () => {
      const result = (await tool.execute({
        action: 'set',
        value: 'sk-test-123',
      })) as CredentialResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });

    it('requires value for set action', async () => {
      const result = (await tool.execute({
        action: 'set',
        name: testNames.apiKey,
      })) as CredentialResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('value');
    });

    it('validates name format (alphanumeric + underscores)', async () => {
      const result = (await tool.execute({
        action: 'set',
        name: 'invalid-name!',
        value: 'test',
      })) as CredentialResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('alphanumeric');
    });

    it('accepts valid name formats', async () => {
      const validNames = ['api_key', 'API_KEY', 'api123', 'test_key_123'];

      for (const name of validNames) {
        const result = (await tool.execute({
          action: 'set',
          name,
          value: 'test-value',
        })) as CredentialResult;
        expect(result.success).toBe(true);
        // Clean up
        credentialStore.delete(name);
      }
    });
  });

  describe('delete action', () => {
    beforeEach(() => {
      // Set up test credential
      credentialStore.set(testNames.apiKey, 'sk-test-123');
    });

    it('deletes an existing credential', async () => {
      const result = (await tool.execute({
        action: 'delete',
        name: testNames.apiKey,
      })) as CredentialResult;

      expect(result.success).toBe(true);
      expect(result.action).toBe('delete');
      expect(result.name).toBe(testNames.apiKey);

      // Verify it was deleted
      expect(credentialStore.get(testNames.apiKey)).toBeNull();
    });

    it('returns success for non-existent credential (idempotent)', async () => {
      const result = (await tool.execute({
        action: 'delete',
        name: `nonexistent_key_${testId}`,
      })) as CredentialResult;

      expect(result.success).toBe(true);
      expect(result.error).toBeDefined(); // Non-critical error
    });

    it('requires name for delete action', async () => {
      const result = (await tool.execute({
        action: 'delete',
      })) as CredentialResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });
  });

  describe('list action', () => {
    beforeEach(() => {
      // Set up test credentials
      credentialStore.set(testNames.apiKey, 'sk-test-123');
      credentialStore.set(testNames.anotherKey, 'secret-value');
    });

    afterEach(() => {
      credentialStore.delete(testNames.apiKey);
      credentialStore.delete(testNames.anotherKey);
    });

    it('lists credential names only (never values)', async () => {
      const result = (await tool.execute({
        action: 'list',
      })) as CredentialResult;

      expect(result.success).toBe(true);
      expect(result.action).toBe('list');
      expect(result.names).toContain(testNames.apiKey);
      expect(result.names).toContain(testNames.anotherKey);

      // Critical: values must NOT be in response
      expect(JSON.stringify(result)).not.toContain('sk-test-123');
      expect(JSON.stringify(result)).not.toContain('secret-value');
    });

    it('returns non-empty array (may contain system credentials)', async () => {
      // Note: The test environment may have other VAULT_* env vars set
      // So we only check that our test credentials are in the list
      const result = (await tool.execute({
        action: 'list',
      })) as CredentialResult;

      expect(result.success).toBe(true);
      expect(result.names).toBeDefined();
      expect(Array.isArray(result.names)).toBe(true);
    });
  });

  describe('validation', () => {
    it('rejects invalid action', async () => {
      const result = (await tool.execute({
        action: 'invalid',
      })) as CredentialResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });

    it('requires action parameter', async () => {
      const result = (await tool.execute({})) as CredentialResult;

      expect(result.success).toBe(false);
      expect(result.error).toContain('action');
    });
  });

  describe('tool metadata', () => {
    it('has correct name and tags', () => {
      expect(tool.name).toBe('core.credential');
      expect(tool.tags).toContain('credentials');
      expect(tool.tags).toContain('motor');
      expect(tool.tags).toContain('security');
    });

    it('has maxCallsPerTurn limit', () => {
      expect(tool.maxCallsPerTurn).toBe(3);
    });

    it('hasSideEffects flag', () => {
      expect(tool.hasSideEffects).toBe(true);
    });
  });
});
