/**
 * Tests for skill-loader.ts
 *
 * Validates: Agent Skills standard parsing, lenient YAML (nested blocks skipped),
 * policy.json load/save, index operations, content hash verification.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseSkillFile,
  validateSkillFrontmatter,
  loadPolicy,
  savePolicy,
  loadSkill,
  computeDirectoryHash,
  parseSkillInputs,
} from '../../../../src/runtime/skills/skill-loader.js';
import { mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('parseSkillFile', () => {
  it('parses Agent Skills standard format', () => {
    const content = `---
name: test-skill
description: A test skill
license: MIT
---
# Test Skill

This is body.
`;
    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.frontmatter['name']).toBe('test-skill');
      expect(result.frontmatter['description']).toBe('A test skill');
      expect(result.frontmatter['license']).toBe('MIT');
      expect(result.body).toContain('# Test Skill');
    }
  });

  it('requires only name and description', () => {
    const content = `---
name: minimal
description: Minimal skill
---
Body`;
    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.frontmatter['name']).toBe('minimal');
      expect(result.frontmatter['description']).toBe('Minimal skill');
    }
  });

  it('parses nested metadata blocks', () => {
    const content = `---
name: with-metadata
description: Skill with nested metadata
metadata:
  author: Test Author
  version: 1.0.0
---
Body`;
    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.frontmatter['name']).toBe('with-metadata');
      // gray-matter fully parses nested objects
      const metadata = result.frontmatter['metadata'] as Record<string, unknown>;
      expect(metadata['author']).toBe('Test Author');
      expect(metadata['version']).toBe('1.0.0');
    }
  });

  it('returns empty frontmatter for missing opening delimiter', () => {
    const content = `name: test
description: test
---
Body`;
    const result = parseSkillFile(content);
    // gray-matter returns empty data when no frontmatter delimiters found
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(Object.keys(result.frontmatter)).toHaveLength(0);
    }
  });

  it('returns error for missing closing delimiter', () => {
    const content = `---
name: test
description: test
Body`;
    const result = parseSkillFile(content);
    expect('error' in result).toBe(true);
  });

  it('parses skills.sh inputs block sequence format', () => {
    const content = `---
name: send-email
description: Send emails via Resend API
inputs:
    - name: RESEND_API_KEY
      description: Resend API key for sending emails
      required: true
    - name: RESEND_WEBHOOK_SECRET
      description: Webhook signing secret
      required: false
---
# Send Email`;
    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.frontmatter['name']).toBe('send-email');
    expect(Array.isArray(result.frontmatter['inputs'])).toBe(true);
    const inputs = result.frontmatter['inputs'] as Array<Record<string, unknown>>;
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!['name']).toBe('RESEND_API_KEY');
    expect(inputs[0]!['description']).toBe('Resend API key for sending emails');
    expect(inputs[0]!['required']).toBe(true);
    expect(inputs[1]!['name']).toBe('RESEND_WEBHOOK_SECRET');
    expect(inputs[1]!['required']).toBe(false);

    // Validate that frontmatter passes validation
    const errors = validateSkillFrontmatter(result.frontmatter);
    expect(errors).toEqual([]);
  });
});

describe('validateSkillFrontmatter', () => {
  it('passes for valid Agent Skills standard', () => {
    const frontmatter = {
      name: 'valid-skill',
      description: 'A valid skill',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors).toHaveLength(0);
  });

  it('requires name field', () => {
    const frontmatter = {
      description: 'Missing name',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('requires description field', () => {
    const frontmatter = {
      name: 'test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('description'))).toBe(true);
  });

  it('validates name format - must start with letter', () => {
    const frontmatter = {
      name: '123starts-with-number',
      description: 'Test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('start with a letter'))).toBe(true);
  });

  it('validates name format - rejects leading hyphen', () => {
    const frontmatter = {
      name: '-leading-hyphen',
      description: 'Test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('leading'))).toBe(true);
  });

  it('validates name format - rejects trailing hyphen', () => {
    const frontmatter = {
      name: 'trailing-hyphen-',
      description: 'Test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('trailing'))).toBe(true);
  });

  it('validates name format - rejects consecutive hyphens', () => {
    const frontmatter = {
      name: 'consecutive--hyphens',
      description: 'Test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('consecutive'))).toBe(true);
  });

  it('validates name format - rejects names over 64 chars', () => {
    const frontmatter = {
      name: 'a'.repeat(65),
      description: 'Test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('64 characters'))).toBe(true);
  });

  it('accepts valid name format', () => {
    const frontmatter = {
      name: 'valid-skill-name-123',
      description: 'Test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors).toHaveLength(0);
  });
});

describe('policy.json operations', () => {
  const testDir = join(tmpdir(), `skill-test-${String(Date.now())}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('saves and loads policy', async () => {
    const policy = {
      schemaVersion: 1,
      trust: 'approved' as const,
      allowedDomains: ['api.example.com'],
      requiredCredentials: ['api_key'],
      approvedBy: 'user' as const,
      approvedAt: new Date().toISOString(),
    };

    await savePolicy(testDir, policy);
    const loaded = await loadPolicy(testDir);

    expect(loaded).not.toBeNull();
    expect(loaded?.trust).toBe('approved');
    expect(loaded?.allowedDomains).toEqual(['api.example.com']);
  });

  it('returns null for missing policy', async () => {
    const loaded = await loadPolicy(testDir);
    expect(loaded).toBeNull();
  });

  it('returns null for invalid policy', async () => {
    await writeFile(join(testDir, 'policy.json'), 'invalid json', 'utf-8');
    const loaded = await loadPolicy(testDir);
    expect(loaded).toBeNull();
  });
});

describe('loadSkill', () => {
  const testDir = join(tmpdir(), `load-skill-test-${String(Date.now())}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
    await mkdir(join(testDir, 'test-skill'), { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('loads skill with frontmatter and body', async () => {
    const skillContent = `---
name: test-skill
description: Test skill
---
# Body
Instructions here.`;
    await writeFile(join(testDir, 'test-skill', 'SKILL.md'), skillContent, 'utf-8');

    const result = await loadSkill('test-skill', testDir);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.frontmatter.name).toBe('test-skill');
      expect(result.body).toContain('# Body');
    }
  });

  it('loads policy if present', async () => {
    const skillContent = `---
name: test-skill
description: Test skill
---
Body`;
    await writeFile(join(testDir, 'test-skill', 'SKILL.md'), skillContent, 'utf-8');

    const policy = {
      schemaVersion: 1,
      trust: 'approved' as const,
      allowedDomains: ['api.example.com'],
      approvedBy: 'user' as const,
      approvedAt: new Date().toISOString(),
      provenance: {
        source: 'test',
        fetchedAt: new Date().toISOString(),
        // No contentHash - not testing hash verification here
      },
    };
    await savePolicy(join(testDir, 'test-skill'), policy);

    const result = await loadSkill('test-skill', testDir);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.policy).toBeDefined();
      expect(result.policy?.trust).toBe('approved');
    }
  });

  it('resets trust to needs_reapproval when content hash mismatches', async () => {
    const originalContent = `---
name: test-skill
description: Original content
---
Original body`;
    await writeFile(join(testDir, 'test-skill', 'SKILL.md'), originalContent, 'utf-8');

    // Create policy with hash of original directory
    const originalHash = await computeDirectoryHash(join(testDir, 'test-skill'));

    const policy = {
      schemaVersion: 1,
      trust: 'approved' as const,
      allowedDomains: ['api.example.com'],
      approvedBy: 'user' as const,
      approvedAt: new Date().toISOString(),
      provenance: {
        source: 'test',
        fetchedAt: new Date().toISOString(),
        contentHash: originalHash,
      },
    };
    await savePolicy(join(testDir, 'test-skill'), policy);

    // Modify SKILL.md after approval
    const modifiedContent = `---
name: test-skill
description: Modified content
---
Modified body`;
    await writeFile(join(testDir, 'test-skill', 'SKILL.md'), modifiedContent, 'utf-8');

    const result = await loadSkill('test-skill', testDir);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      // Trust should be reset to needs_reapproval due to hash mismatch
      expect(result.policy?.trust).toBe('needs_reapproval');
    }
  });

  it('keeps trust approved when content hash matches', async () => {
    const content = `---
name: test-skill
description: Stable content
---
Body`;
    await writeFile(join(testDir, 'test-skill', 'SKILL.md'), content, 'utf-8');

    // Create policy with correct hash (directory hash)
    const correctHash = await computeDirectoryHash(join(testDir, 'test-skill'));

    const policy = {
      schemaVersion: 1,
      trust: 'approved' as const,
      allowedDomains: ['api.example.com'],
      approvedBy: 'user' as const,
      approvedAt: new Date().toISOString(),
      provenance: {
        source: 'test',
        fetchedAt: new Date().toISOString(),
        contentHash: correctHash,
      },
    };
    await savePolicy(join(testDir, 'test-skill'), policy);

    const result = await loadSkill('test-skill', testDir);

    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.policy?.trust).toBe('approved');
    }
  });

  it('returns error for missing skill', async () => {
    const result = await loadSkill('nonexistent', testDir);
    expect('error' in result).toBe(true);
  });
});

describe('computeDirectoryHash', () => {
  const testDir = join(tmpdir(), `hash-test-${String(Date.now())}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('computes hash over all files excluding policy.json', async () => {
    const skillDir = join(testDir, 'skill');
    await mkdir(skillDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Skill', 'utf-8');
    await writeFile(join(skillDir, 'script.sh'), 'echo test', 'utf-8');
    await writeFile(join(skillDir, 'policy.json'), '{"trust": "approved"}', 'utf-8');

    const hash = await computeDirectoryHash(skillDir);
    expect(hash).toMatch(/^sha256:[a-f0-9]+$/);
  });

  it('produces different hash when content changes', async () => {
    const skillDir = join(testDir, 'skill');
    await mkdir(skillDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Original', 'utf-8');

    const hash1 = await computeDirectoryHash(skillDir);

    // Modify content
    await writeFile(join(skillDir, 'SKILL.md'), '# Modified', 'utf-8');

    const hash2 = await computeDirectoryHash(skillDir);

    expect(hash1).not.toBe(hash2);
  });

  it('produces same hash for identical content (deterministic)', async () => {
    const skillDir = join(testDir, 'skill');
    await mkdir(skillDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Same Content', 'utf-8');
    await writeFile(join(skillDir, 'script.sh'), 'echo test', 'utf-8');

    const hash1 = await computeDirectoryHash(skillDir);
    const hash2 = await computeDirectoryHash(skillDir);

    expect(hash1).toBe(hash2);
  });

  it('excludes policy.json from hash', async () => {
    const skillDir = join(testDir, 'skill');
    await mkdir(skillDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Skill', 'utf-8');
    await writeFile(join(skillDir, 'policy.json'), '{"trust": "approved"}', 'utf-8');

    const hash1 = await computeDirectoryHash(skillDir);

    // Modify policy.json - hash should not change
    await writeFile(join(skillDir, 'policy.json'), '{"trust": "unknown"}', 'utf-8');

    const hash2 = await computeDirectoryHash(skillDir);

    expect(hash1).toBe(hash2);
  });

  it('includes subdirectories in hash', async () => {
    const skillDir = join(testDir, 'skill');
    const scriptsDir = join(skillDir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Skill', 'utf-8');
    await writeFile(join(scriptsDir, 'run.sh'), 'echo run', 'utf-8');

    const hash = await computeDirectoryHash(skillDir);
    expect(hash).toMatch(/^sha256:[a-f0-9]+$/);
  });

  it('produces different hash when subdirectory content changes', async () => {
    const skillDir = join(testDir, 'skill');
    const scriptsDir = join(skillDir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Skill', 'utf-8');
    await writeFile(join(scriptsDir, 'run.sh'), 'echo original', 'utf-8');

    const hash1 = await computeDirectoryHash(skillDir);

    // Modify script in subdirectory
    await writeFile(join(scriptsDir, 'run.sh'), 'echo modified', 'utf-8');

    const hash2 = await computeDirectoryHash(skillDir);

    expect(hash1).not.toBe(hash2);
  });

  it('rejects symlinks in directory tree', async () => {
    const skillDir = join(testDir, 'skill');
    await mkdir(skillDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Skill', 'utf-8');

    try {
      await symlink('/etc/passwd', join(skillDir, 'link'));
    } catch {
      // Skip test if symlinks not supported
      return;
    }

    await expect(computeDirectoryHash(skillDir)).rejects.toThrow('Symlink detected');
  });

  it('returns hash for empty directory (no files)', async () => {
    const skillDir = join(testDir, 'skill');
    await mkdir(skillDir, { recursive: true });

    const hash = await computeDirectoryHash(skillDir);
    expect(hash).toBe('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('skips dotfiles in hash computation', async () => {
    const skillDir = join(testDir, 'skill');
    await mkdir(skillDir, { recursive: true });

    await writeFile(join(skillDir, 'SKILL.md'), '# Skill', 'utf-8');
    await writeFile(join(skillDir, '.DS_Store'), 'x', 'utf-8');

    const hash1 = await computeDirectoryHash(skillDir);

    // Remove dotfile - hash should be same
    await rm(join(skillDir, '.DS_Store'));

    const hash2 = await computeDirectoryHash(skillDir);

    expect(hash1).toBe(hash2);
  });
});

describe('parseSkillInputs', () => {
  it('parses valid inputs array', () => {
    const raw = [
      { name: 'API_KEY', description: 'API key', required: true },
      { name: 'TIMEOUT', type: 'number', description: 'Timeout in ms', required: false, default: 5000 },
    ];
    const result = parseSkillInputs(raw);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      name: 'API_KEY',
      type: 'string',
      description: 'API key',
      required: true,
    });
    expect(result[1]).toEqual({
      name: 'TIMEOUT',
      type: 'number',
      description: 'Timeout in ms',
      required: false,
      default: 5000,
    });
  });

  it('applies defaults for missing fields', () => {
    const raw = [{ name: 'MINIMAL' }];
    const result = parseSkillInputs(raw);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: 'MINIMAL',
      type: 'string',
      description: '',
      required: true,
    });
  });

  it('skips entries with missing name', () => {
    const raw = [
      { description: 'No name' },
      { name: '', description: 'Empty name' },
      { name: 'VALID', description: 'Valid entry' },
    ];
    const result = parseSkillInputs(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('VALID');
  });

  it('skips entries with non-object types', () => {
    const raw = [
      'string entry',
      null,
      123,
      { name: 'VALID', type: 'string' },
    ];
    const result = parseSkillInputs(raw);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('VALID');
  });

  it('skips duplicate names (first wins)', () => {
    const raw = [
      { name: 'DUP', description: 'First', type: 'string' },
      { name: 'DUP', description: 'Second', type: 'number' },
      { name: 'UNIQUE', description: 'Unique' },
    ];
    const result = parseSkillInputs(raw);

    expect(result).toHaveLength(2);
    expect(result[0]?.description).toBe('First');
    expect(result[0]?.type).toBe('string');
    expect(result[1]?.name).toBe('UNIQUE');
  });

  it('validates type field and defaults invalid types to string', () => {
    const raw = [
      { name: 'A', type: 'string' },
      { name: 'B', type: 'number' },
      { name: 'C', type: 'boolean' },
      { name: 'D', type: 'invalid' },
      { name: 'E', type: 123 },
    ];
    const result = parseSkillInputs(raw);

    expect(result).toHaveLength(5);
    expect(result[0]?.type).toBe('string');
    expect(result[1]?.type).toBe('number');
    expect(result[2]?.type).toBe('boolean');
    expect(result[3]?.type).toBe('string'); // invalid -> default
    expect(result[4]?.type).toBe('string'); // non-string -> default
  });

  it('returns empty array for empty input', () => {
    expect(parseSkillInputs([])).toEqual([]);
  });
});
