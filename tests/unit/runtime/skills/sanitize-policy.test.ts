/**
 * Tests for sanitizePolicyForDisplay — credential value redaction.
 */

import { describe, it, expect } from 'vitest';
import { sanitizePolicyForDisplay } from '../../../../src/runtime/skills/skill-types.js';
import type { SkillPolicy } from '../../../../src/runtime/skills/skill-types.js';

describe('sanitizePolicyForDisplay', () => {
  const basePolicy: SkillPolicy = {
    schemaVersion: 1,
    trust: 'approved',
    allowedTools: ['bash', 'fetch'],
    allowedDomains: ['api.example.com'],
    requiredCredentials: ['api_key', 'secret_token'],
  };

  it('returns policy unchanged when no credentialValues', () => {
    const result = sanitizePolicyForDisplay(basePolicy);
    expect(result).toBe(basePolicy); // Same reference — no copy needed
  });

  it('redacts all credential values to "[set]"', () => {
    const policy: SkillPolicy = {
      ...basePolicy,
      credentialValues: {
        api_key: 'sk-live-super-secret-key-12345',
        secret_token: 'tok_abc123xyz',
      },
    };

    const result = sanitizePolicyForDisplay(policy);

    expect(result.credentialValues).toEqual({
      api_key: '[set]',
      secret_token: '[set]',
    });
  });

  it('preserves all non-credential fields', () => {
    const policy: SkillPolicy = {
      ...basePolicy,
      credentialValues: { api_key: 'secret' },
      approvedBy: 'user',
      approvedAt: '2026-01-01T00:00:00Z',
    };

    const result = sanitizePolicyForDisplay(policy);

    expect(result.schemaVersion).toBe(1);
    expect(result.trust).toBe('approved');
    expect(result.allowedTools).toEqual(['bash', 'fetch']);
    expect(result.allowedDomains).toEqual(['api.example.com']);
    expect(result.requiredCredentials).toEqual(['api_key', 'secret_token']);
    expect(result.approvedBy).toBe('user');
    expect(result.approvedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('returns a new object (does not mutate original)', () => {
    const policy: SkillPolicy = {
      ...basePolicy,
      credentialValues: { api_key: 'secret' },
    };

    const result = sanitizePolicyForDisplay(policy);

    expect(result).not.toBe(policy);
    expect(policy.credentialValues!['api_key']).toBe('secret'); // Original unchanged
  });

  it('handles empty credentialValues object', () => {
    const policy: SkillPolicy = {
      ...basePolicy,
      credentialValues: {},
    };

    // Empty object is still truthy, so it should be processed
    const result = sanitizePolicyForDisplay(policy);
    expect(result.credentialValues).toEqual({});
  });
});
