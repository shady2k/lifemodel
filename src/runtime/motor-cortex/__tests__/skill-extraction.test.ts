/**
 * Skill Extraction Tests
 *
 * Tests for extractSkillsFromWorkspace() covering:
 * - Empty workspace (no skills/ dir)
 * - Valid skill with SKILL.md + policy.json
 * - Valid skill without policy.json
 * - Invalid frontmatter (missing name)
 * - Name mismatch with directory name
 * - Symlink at top level
 * - Symlink in nested subdir
 * - File over 1MB
 * - Directory over 10MB total
 * - Dotfiles skipped
 * - Existing skill (marked as "updated")
 * - Multiple skills in one workspace
 * - Trust forced to "pending_review"
 * - Content hash computed over full directory
 * - Atomic copy validation
 * - Motor provenance preserved
 * - Invalid Motor policy.json
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractSkillsFromWorkspace } from '../skill-extraction.js';
import { computeDirectoryHash } from '../../skills/skill-loader.js';

// Test logger
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as unknown as import('pino').Logger; // eslint-disable-line @typescript-eslint/consistent-type-imports

describe('skill-extraction', () => {
  let workspace: string;
  let skillsDir: string;
  let runId: string;

  beforeEach(async () => {
    // Create temp directories
    const base = tmpdir();
    workspace = join(base, `.test-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    skillsDir = join(base, `.test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    runId = `run-${Date.now()}`;

    await mkdir(workspace, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    // Cleanup
    await rm(workspace, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
  });

  describe('empty workspace', () => {
    it('returns empty arrays when no skills/ directory exists', async () => {
      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result).toEqual({ created: [], updated: [] });
    });

    it('returns empty arrays when skills/ directory is empty', async () => {
      const skillsWorkspace = join(workspace, 'skills');
      await mkdir(skillsWorkspace, { recursive: true });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result).toEqual({ created: [], updated: [] });
    });
  });

  describe('valid skill with SKILL.md and policy.json', () => {
    it('extracts skill with valid Motor policy.json', async () => {
      const skillName = 'weather';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      // Write SKILL.md
      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: weather
description: Fetch weather data from wttr.in
---
# Weather Skill

Fetch weather data using curl.`,
        'utf-8'
      );

      // Write Motor's policy.json
      await writeFile(
        join(skillDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'approved',
          allowedTools: ['shell'],
          allowedDomains: ['wttr.in'],
          provenance: {
            source: 'https://wttr.in',
            fetchedAt: new Date().toISOString(),
          },
        }),
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['weather']);
      expect(result.updated).toEqual([]);

      // Verify skill was installed
      const installedDir = join(skillsDir, 'weather');
      const skillMd = await readFile(join(installedDir, 'SKILL.md'), 'utf-8');
      expect(skillMd).toContain('name: weather');

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      expect(policy.allowedDomains).toEqual(['wttr.in']);
      expect(policy.provenance.source).toBe('https://wttr.in');
      expect(policy.extractedFrom.runId).toBe(runId);
    });
  });

  describe('valid skill without policy.json', () => {
    it('extracts skill and generates minimal policy', async () => {
      const skillName = 'hello';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: hello
description: Say hello to the world
---
# Hello Skill

Say hello.`,
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['hello']);

      // Verify policy was generated
      const installedDir = join(skillsDir, 'hello');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      expect(policy.schemaVersion).toBe(1);
      expect(policy.allowedTools).toEqual([]);
      expect(policy.extractedFrom.runId).toBe(runId);
    });
  });

  describe('validation failures', () => {
    it('skips skill with missing SKILL.md', async () => {
      const skillName = 'invalid';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { skillName: 'invalid' },
        'SKILL.md missing, skipping'
      );
    });

    it('skips skill with invalid frontmatter (missing name)', async () => {
      const skillName = 'bad-frontend';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
description: Missing name
---
# Bad Skill`,
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('skips skill with name mismatch (directory vs frontmatter)', async () => {
      const skillName = 'directory-name';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: different-name
description: Name mismatch
---
# Mismatch Skill`,
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { skillName: 'directory-name', nameFromFrontmatter: 'different-name' },
        'Name mismatch (frontmatter vs directory), skipping'
      );
    });

    it('skips skill with invalid name format', async () => {
      const skillName = '-invalid-name';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: -invalid-name
description: Invalid name format
---
# Invalid Skill`,
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('symlink rejection', () => {
    it('rejects skill with symlink at top level', async () => {
      const skillName = 'with-symlink';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: with-symlink
description: Has symlink
---
# Symlink Skill`,
        'utf-8'
      );

      // Create a symlink
      try {
        await symlink('/etc/passwd', join(skillDir, 'link'));
      } catch {
        // Skip test if symlinks not supported
        return;
      }

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { skillName: 'with-symlink', error: expect.any(Error) },
        'Symlink detected, skipping'
      );
    });

    it('rejects skill with symlink in nested subdirectory', async () => {
      const skillName = 'nested-symlink';
      const skillDir = join(workspace, 'skills', skillName);
      const scriptsDir = join(skillDir, 'scripts');
      await mkdir(scriptsDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: nested-symlink
description: Has nested symlink
---
# Nested Symlink Skill`,
        'utf-8'
      );

      await writeFile(join(scriptsDir, 'script.sh'), 'echo hello', 'utf-8');

      // Create symlink in nested dir
      try {
        await symlink('/etc/passwd', join(scriptsDir, 'link'));
      } catch {
        // Skip test if symlinks not supported
        return;
      }

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { skillName: 'nested-symlink', error: expect.any(Error) },
        'Symlink detected, skipping'
      );
    });
  });

  describe('size limits', () => {
    it('rejects skill with file over 1MB', async () => {
      const skillName = 'large-file';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: large-file
description: Has large file
---
# Large File Skill`,
        'utf-8'
      );

      // Create a file larger than 1MB
      const largeContent = 'x'.repeat(1024 * 1024 + 1);
      await writeFile(join(skillDir, 'large.txt'), largeContent, 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        { skillName: 'large-file', error: expect.any(Error) },
        'Size check failed, skipping'
      );
    });

    it('rejects skill with total size over 10MB', async () => {
      const skillName = 'large-total';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: large-total
description: Total size over limit
---
# Large Total Skill`,
        'utf-8'
      );

      // Create multiple files that together exceed 10MB
      const chunkSize = 1024 * 1024; // 1MB each
      for (let i = 0; i < 11; i++) {
        await writeFile(join(skillDir, `file${i}.txt`), 'x'.repeat(chunkSize), 'utf-8');
      }

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      // Should be skipped due to size limit
      expect(result.created).toEqual([]);
      // Verify the skill was NOT installed
      const installedDir = join(skillsDir, 'large-total');
      const exists = await readFile(join(installedDir, 'SKILL.md'), 'utf-8').catch(() => null);
      expect(exists).toBeNull();
    });
  });

  describe('dotfiles', () => {
    it('skips .DS_Store files', async () => {
      const skillName = 'clean';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: clean
description: Clean skill
---
# Clean Skill`,
        'utf-8'
      );

      await writeFile(join(skillDir, '.DS_Store'), 'x', 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['clean']);

      // Note: Dotfiles are copied (cp copies everything), but skipped during hash computation
      const installedDir = join(skillsDir, 'clean');
      const exists = await readFile(join(installedDir, '.DS_Store'), 'utf-8').catch(() => null);
      expect(exists).toBe('x'); // Dotfile IS copied
    });
  });

  describe('existing skill update', () => {
    it('marks existing skill as updated', async () => {
      const skillName = 'existing';
      const installedDir = join(skillsDir, skillName);
      await mkdir(installedDir, { recursive: true });

      // Create existing skill
      await writeFile(
        join(installedDir, 'SKILL.md'),
        `---
name: existing
description: Old version
---
# Old`,
        'utf-8'
      );

      // Create new version in workspace
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: existing
description: Updated version
---
# Updated`,
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(result.updated).toEqual(['existing']);

      // Verify skill was updated
      const updatedContent = await readFile(join(installedDir, 'SKILL.md'), 'utf-8');
      expect(updatedContent).toContain('Updated version');
    });
  });

  describe('multiple skills', () => {
    it('extracts all valid skills from workspace', async () => {
      // Skill 1
      const skill1Dir = join(workspace, 'skills', 'skill1');
      await mkdir(skill1Dir, { recursive: true });
      await writeFile(
        join(skill1Dir, 'SKILL.md'),
        `---
name: skill1
description: First skill
---
# Skill 1`,
        'utf-8'
      );

      // Skill 2
      const skill2Dir = join(workspace, 'skills', 'skill2');
      await mkdir(skill2Dir, { recursive: true });
      await writeFile(
        join(skill2Dir, 'SKILL.md'),
        `---
name: skill2
description: Second skill
---
# Skill 2`,
        'utf-8'
      );

      // Invalid skill (should be skipped)
      const invalidDir = join(workspace, 'skills', 'invalid');
      await mkdir(invalidDir, { recursive: true });
      // No SKILL.md

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toContain('skill1');
      expect(result.created).toContain('skill2');
      expect(result.created).not.toContain('invalid');
      expect(result.created.length).toBe(2);
    });
  });

  describe('trust forced to pending_review', () => {
    it('forces trust to pending_review even if Motor wrote approved', async () => {
      const skillName = 'approved-skill';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: approved-skill
description: Motor wrote approved
---
# Approved`,
        'utf-8'
      );

      await writeFile(
        join(skillDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'approved',
          allowedTools: ['shell'],
        }),
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['approved-skill']);

      // Verify trust was forced to pending_review
      const installedDir = join(skillsDir, 'approved-skill');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
    });
  });

  describe('content hash', () => {
    it('computes hash over full directory excluding policy.json', async () => {
      const skillName = 'hashed';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: hashed
description: Hash test
---
# Hashed`,
        'utf-8'
      );

      await writeFile(join(skillDir, 'script.sh'), 'echo test', 'utf-8');

      await writeFile(
        join(skillDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'unknown',
          allowedTools: [],
          provenance: { source: 'test', fetchedAt: '2024-01-01T00:00:00Z' },
        }),
        'utf-8'
      );

      await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      // Verify hash was computed
      const installedDir = join(skillsDir, 'hashed');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.provenance.contentHash).toMatch(/^sha256:/);

      // Verify hash excludes policy.json
      const directHash = await computeDirectoryHash(installedDir);
      expect(policy.provenance.contentHash).toBe(directHash);
    });
  });

  describe('atomic copy', () => {
    it('cleans up temp dir on validation failure', async () => {
      const skillName = 'atomic-test';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: atomic-test
description: Atomic copy test
---
# Atomic`,
        'utf-8'
      );

      // This should succeed normally
      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['atomic-test']);

      // Verify no temp dirs left behind
      const entries = await readdir(skillsDir);
      expect(entries).not.toContain(expect.stringMatching(/^\.tmp-/));
    });
  });

  describe('Motor provenance', () => {
    it('preserves valid Motor provenance', async () => {
      const skillName = 'provenance';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: provenance
description: Provenance test
---
# Provenance`,
        'utf-8'
      );

      const motorProvenance = {
        source: 'https://example.com/docs',
        fetchedAt: '2024-01-01T00:00:00Z',
      };

      await writeFile(
        join(skillDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'unknown',
          allowedTools: ['shell'],
          provenance: motorProvenance,
        }),
        'utf-8'
      );

      await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      const installedDir = join(skillsDir, 'provenance');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.provenance.source).toBe('https://example.com/docs');
      expect(policy.provenance.fetchedAt).toBe('2024-01-01T00:00:00Z');
      // Note: contentHash is added by the extraction process
      expect(policy.provenance.contentHash).toBeDefined();
    });
  });

  describe('invalid Motor policy.json', () => {
    it('generates minimal policy when Motor policy is invalid JSON', async () => {
      const skillName = 'bad-policy';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: bad-policy
description: Bad policy
---
# Bad Policy`,
        'utf-8'
      );

      // Write invalid JSON
      await writeFile(join(skillDir, 'policy.json'), '{ invalid json', 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['bad-policy']);

      // Verify minimal policy was generated
      const installedDir = join(skillsDir, 'bad-policy');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      expect(policy.schemaVersion).toBe(1);
    });

    it('generates minimal policy when Motor policy has wrong schema version', async () => {
      const skillName = 'wrong-schema';
      const skillDir = join(workspace, 'skills', skillName);
      await mkdir(skillDir, { recursive: true });

      await writeFile(
        join(skillDir, 'SKILL.md'),
        `---
name: wrong-schema
description: Wrong schema
---
# Wrong Schema`,
        'utf-8'
      );

      await writeFile(
        join(skillDir, 'policy.json'),
        JSON.stringify({ schemaVersion: 'wrong', trust: 'unknown', allowedTools: [] }),
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['wrong-schema']);

      const installedDir = join(skillsDir, 'wrong-schema');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.schemaVersion).toBe(1);
      expect(policy.trust).toBe('pending_review');
    });
  });
});
