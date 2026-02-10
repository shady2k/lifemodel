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
  loadSkillIndex,
  saveSkillIndex,
  updateSkillIndex,
  loadSkill,
} from '../skill-loader.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { MotorTool } from '../../motor-cortex/motor-protocol.js';

describe('parseSkillFile', () => {
  it('parses Agent Skills standard format', () => {
    const content = `---
name: test-skill
description: A test skill
license: MIT
---
# Test Skill

This is the body.
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

  it('skips nested metadata blocks (lenient parsing)', () => {
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
      // Should skip the nested metadata block
      expect(result.frontmatter['name']).toBe('with-metadata');
      // metadata should not be in frontmatter
      expect(result.frontmatter['metadata']).toBeUndefined();
    }
  });

  it('returns error for missing opening delimiter', () => {
    const content = `name: test
description: test
---
Body`;
    const result = parseSkillFile(content);
    expect('error' in result).toBe(true);
    if ('error' in result) {
      expect(result.error).toContain('---');
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

  it('validates name format', () => {
    const frontmatter = {
      name: 'Invalid Name!',
      description: 'Test',
    };
    const errors = validateSkillFrontmatter(frontmatter);
    expect(errors.some((e) => e.includes('lowercase alphanumeric'))).toBe(true);
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
      allowedTools: ['code', 'shell'] as MotorTool[],
      allowedDomains: ['api.example.com'],
      requiredCredentials: ['api_key'],
      approvedBy: 'user' as const,
      approvedAt: new Date().toISOString(),
    };

    await savePolicy(testDir, policy);
    const loaded = await loadPolicy(testDir);

    expect(loaded).not.toBeNull();
    expect(loaded?.trust).toBe('approved');
    expect(loaded?.allowedTools).toEqual(['code', 'shell']);
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

describe('index.json operations', () => {
  const testDir = join(tmpdir(), `skill-index-test-${String(Date.now())}`);

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('saves and loads index', async () => {
    const index = {
      schemaVersion: 1,
      skills: {
        'test-skill': {
          description: 'Test skill',
          trust: 'approved' as const,
          hasPolicy: true,
          lastUsed: new Date().toISOString(),
        },
      },
    };

    await saveSkillIndex(testDir, index);
    const loaded = await loadSkillIndex(testDir);

    expect(loaded.schemaVersion).toBe(1);
    expect(loaded.skills['test-skill']).toBeDefined();
    expect(loaded.skills['test-skill']?.trust).toBe('approved');
  });

  it('returns empty index for missing file', async () => {
    const loaded = await loadSkillIndex(testDir);
    expect(loaded.schemaVersion).toBe(1);
    expect(Object.keys(loaded.skills)).toHaveLength(0);
  });

  it('updates single entry in index', async () => {
    const index = {
      schemaVersion: 1,
      skills: {},
    };
    await saveSkillIndex(testDir, index);

    await updateSkillIndex(testDir, 'new-skill', {
      description: 'New skill',
      trust: 'unknown' as const,
      hasPolicy: false,
    });

    const loaded = await loadSkillIndex(testDir);
    expect(loaded.skills['new-skill']).toBeDefined();
    expect(loaded.skills['new-skill']?.trust).toBe('unknown');
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
      allowedTools: ['code'] as MotorTool[],
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

  it('resets trust to unknown when content hash mismatches', async () => {
    const originalContent = `---
name: test-skill
description: Original content
---
Original body`;
    await writeFile(join(testDir, 'test-skill', 'SKILL.md'), originalContent, 'utf-8');

    // Create policy with hash of original content
    const { createHash } = await import('node:crypto');
    const originalHash = `sha256:${createHash('sha256').update(originalContent, 'utf-8').digest('hex')}`;

    const policy = {
      schemaVersion: 1,
      trust: 'approved' as const,
      allowedTools: ['code'] as MotorTool[],
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
      // Trust should be reset to unknown due to hash mismatch
      expect(result.policy?.trust).toBe('unknown');
    }
  });

  it('keeps trust approved when content hash matches', async () => {
    const content = `---
name: test-skill
description: Stable content
---
Body`;
    await writeFile(join(testDir, 'test-skill', 'SKILL.md'), content, 'utf-8');

    // Create policy with correct hash
    const { createHash } = await import('node:crypto');
    const correctHash = `sha256:${createHash('sha256').update(content, 'utf-8').digest('hex')}`;

    const policy = {
      schemaVersion: 1,
      trust: 'approved' as const,
      allowedTools: ['code'] as MotorTool[],
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
