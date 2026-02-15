/**
 * Skill Extraction Tests
 *
 * Tests for extractSkillsFromWorkspace() covering:
 * - Empty workspace (no SKILL.md)
 * - New skill creation (no baseline)
 * - Existing skill with baseline-diff (unchanged = skip, changed = extract)
 * - Policy handling
 * - Symlink rejection
 * - Status forced to "pending_review"
 * - Credential persistence
 * - contentHash stamped in provenance
 * - changedFiles and deletedFiles populated from baseline diff
 * - Delete semantics (clean replacement)
 * - Size limits (1MB per file, 10MB total)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, readFile, symlink, rm, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractSkillsFromWorkspace,
  generateBaseline,
} from '../../../../src/runtime/motor-cortex/skill-extraction.js';
import { createTestPolicy } from '../../../helpers/factories.js';

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
    const base = tmpdir();
    workspace = join(base, `test-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    skillsDir = join(base, `test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    runId = `run-${Date.now()}`;

    await mkdir(workspace, { recursive: true });
    await mkdir(skillsDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
  });

  /** Helper: write SKILL.md at workspace root */
  async function writeSkillMd(name: string, description: string, body = '# Skill'): Promise<void> {
    await writeFile(
      join(workspace, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
      'utf-8'
    );
  }

  /** Helper: generate and write baseline from current workspace state */
  async function writeBaseline(): Promise<void> {
    const baseline = await generateBaseline(workspace);
    await writeFile(
      join(workspace, '.motor-baseline.json'),
      JSON.stringify(baseline, null, 2),
      'utf-8'
    );
  }

  /** Helper: pre-install a skill with optional policy */
  async function preInstallSkill(name: string, skillMd: string, policy?: Record<string, unknown>): Promise<string> {
    const installedDir = join(skillsDir, name);
    await mkdir(installedDir, { recursive: true });
    await writeFile(join(installedDir, 'SKILL.md'), skillMd, 'utf-8');
    if (policy) {
      await writeFile(join(installedDir, 'policy.json'), JSON.stringify(policy), 'utf-8');
    }
    return installedDir;
  }

  describe('empty workspace', () => {
    it('returns empty arrays when no SKILL.md exists', async () => {
      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result).toEqual({ created: [], updated: [] });
    });

    it('returns empty arrays when workspace has non-skill files only', async () => {
      await writeFile(join(workspace, 'output.txt'), 'hello', 'utf-8');
      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result).toEqual({ created: [], updated: [] });
    });
  });

  describe('new skill creation (no baseline)', () => {
    it('extracts new skill with SKILL.md at workspace root', async () => {
      await writeSkillMd('weather', 'Fetch weather data from wttr.in');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['weather']);
      expect(result.updated).toEqual([]);

      // Verify installed
      const installedDir = join(skillsDir, 'weather');
      const skillMd = await readFile(join(installedDir, 'SKILL.md'), 'utf-8');
      expect(skillMd).toContain('name: weather');

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.status).toBe('pending_review');
      expect(policy.schemaVersion).toBe(2);
      expect(policy.extractedFrom.runId).toBe(runId);
    });

    it('generates minimal v2 policy for new skill', async () => {
      await writeSkillMd('hello', 'Say hello to the world');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['hello']);

      const installedDir = join(skillsDir, 'hello');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.status).toBe('pending_review');
      expect(policy.schemaVersion).toBe(2);
      expect(policy.extractedFrom.runId).toBe(runId);
    });
  });

  describe('baseline-diff extraction (existing skill)', () => {
    it('skips extraction when no changes detected', async () => {
      // Pre-install the skill so isUpdate=true (baseline diff only applies to updates)
      await preInstallSkill(
        'existing',
        '---\nname: existing\ndescription: An existing skill\n---\n# Skill',
        createTestPolicy()
      );

      // Simulate: skill copied to workspace, baseline generated, no edits
      await writeSkillMd('existing', 'An existing skill');
      await writeBaseline();

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(result.updated).toEqual([]);
    });

    it('extracts when SKILL.md is modified after baseline', async () => {
      // Pre-install the skill so it counts as update
      await preInstallSkill(
        'existing',
        '---\nname: existing\ndescription: Old\n---\n# Old',
        createTestPolicy()
      );

      // Simulate: skill copied, baseline generated
      await writeSkillMd('existing', 'An existing skill', '# Original');
      await writeBaseline();

      // Agent modifies SKILL.md
      await writeSkillMd('existing', 'An existing skill', '# Updated with fixes');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.updated).toEqual(['existing']);

      const installedDir = join(skillsDir, 'existing');
      const updatedMd = await readFile(join(installedDir, 'SKILL.md'), 'utf-8');
      expect(updatedMd).toContain('Updated with fixes');
    });

    it('detects added files (agent added new references)', async () => {
      await writeSkillMd('existing', 'Skill with refs');
      await writeBaseline();

      // Agent adds a reference file
      await mkdir(join(workspace, 'references'), { recursive: true });
      await writeFile(join(workspace, 'references', 'api.md'), '# API Docs', 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      // New skill (not pre-installed in skillsDir)
      expect(result.created).toEqual(['existing']);
    });
  });

  describe('validation failures', () => {
    it('skips extraction when SKILL.md has invalid frontmatter (missing name)', async () => {
      await writeFile(
        join(workspace, 'SKILL.md'),
        '---\ndescription: Missing name\n---\n# Bad Skill',
        'utf-8'
      );

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual([]);
    });

    it('skips extraction when SKILL.md has invalid name format', async () => {
      await writeSkillMd('-invalid-name', 'Invalid name format');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual([]);
    });
  });

  describe('symlink rejection', () => {
    it('rejects skill with symlink at top level', async () => {
      await writeSkillMd('with-symlink', 'Has symlink');

      try {
        await symlink('/etc/passwd', join(workspace, 'link'));
      } catch {
        return; // Skip if symlinks not supported
      }

      await expect(
        extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger)
      ).rejects.toThrow('Symlink detected');
    });

    it('rejects skill with symlink in nested subdirectory', async () => {
      await writeSkillMd('nested-symlink', 'Has nested symlink');
      const scriptsDir = join(workspace, 'scripts');
      await mkdir(scriptsDir, { recursive: true });
      await writeFile(join(scriptsDir, 'script.sh'), 'echo hello', 'utf-8');

      try {
        await symlink('/etc/passwd', join(scriptsDir, 'link'));
      } catch {
        return;
      }

      await expect(
        extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger)
      ).rejects.toThrow('Symlink detected');
    });
  });

  describe('status forced to pending_review', () => {
    it('forces status to pending_review for new skills', async () => {
      await writeSkillMd('new-skill', 'Brand new');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['new-skill']);

      const installedDir = join(skillsDir, 'new-skill');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.status).toBe('pending_review');
    });

    it('resets status to pending_review on update', async () => {
      await preInstallSkill(
        'approved-skill',
        '---\nname: approved-skill\ndescription: Old\n---\n# Old',
        createTestPolicy()
      );

      await writeSkillMd('approved-skill', 'Updated', '# Updated');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['approved-skill']);

      const installedDir = join(skillsDir, 'approved-skill');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.status).toBe('pending_review');
    });
  });

  describe('atomic copy', () => {
    it('cleans up temp dir on success', async () => {
      await writeSkillMd('atomic-test', 'Atomic copy test');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['atomic-test']);

      // Verify no temp dirs left behind
      const entries = await readdir(skillsDir);
      expect(entries).not.toContain(expect.stringMatching(/^\.tmp-/));
    });
  });

  describe('credential persistence through extraction', () => {
    it('preserves existing credentialValues when updating a skill', async () => {
      await preInstallSkill(
        'with-creds',
        '---\nname: with-creds\ndescription: Has credentials\n---\n# Old',
        createTestPolicy({
          requiredCredentials: ['api_key'],
          credentialValues: { api_key: 'sk-live-secret-12345' },
        })
      );

      await writeSkillMd('with-creds', 'Has credentials', '# Updated instructions');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['with-creds']);

      const installedDir = join(skillsDir, 'with-creds');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.status).toBe('pending_review');
      expect(policy.credentialValues).toEqual({ api_key: 'sk-live-secret-12345' });
    });

    it('merges pendingCredentials into new skill policy', async () => {
      await writeSkillMd('new-skill', 'Brand new skill');

      const pendingCredentials = { signup_key: 'pk-test-abc123' };
      const result = await extractSkillsFromWorkspace(
        workspace,
        skillsDir,
        runId,
        mockLogger,
        pendingCredentials
      );
      expect(result.created).toEqual(['new-skill']);

      const installedDir = join(skillsDir, 'new-skill');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.credentialValues).toEqual({ signup_key: 'pk-test-abc123' });
    });

    it('merges pendingCredentials with existing credentialValues (pending wins)', async () => {
      await preInstallSkill(
        'merge-test',
        '---\nname: merge-test\ndescription: Merge test\n---\n# Old',
        createTestPolicy({
          credentialValues: { old_key: 'old-value', shared_key: 'old-shared' },
        })
      );

      await writeSkillMd('merge-test', 'Merge test', '# Updated');

      const pendingCredentials = { shared_key: 'new-shared', new_key: 'new-value' };
      const result = await extractSkillsFromWorkspace(
        workspace,
        skillsDir,
        runId,
        mockLogger,
        pendingCredentials
      );
      expect(result.updated).toEqual(['merge-test']);

      const installedDir = join(skillsDir, 'merge-test');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.credentialValues).toEqual({
        old_key: 'old-value',
        shared_key: 'new-shared',
        new_key: 'new-value',
      });
    });

    it('omits credentialValues when none exist and no pending', async () => {
      await writeSkillMd('no-creds', 'No credentials');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['no-creds']);

      const installedDir = join(skillsDir, 'no-creds');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.credentialValues).toBeUndefined();
    });
  });

  describe('existing skill update', () => {
    it('marks existing skill as updated (requires existing policy)', async () => {
      await preInstallSkill(
        'existing',
        '---\nname: existing\ndescription: Old version\n---\n# Old',
        createTestPolicy() // Policy required — isUpdate is determined by existing policy.json
      );

      await writeSkillMd('existing', 'Updated version', '# Updated');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(result.updated).toEqual(['existing']);

      const installedDir = join(skillsDir, 'existing');
      const updatedContent = await readFile(join(installedDir, 'SKILL.md'), 'utf-8');
      expect(updatedContent).toContain('Updated version');
    });

    it('preserves existing policy domains on update', async () => {
      await preInstallSkill(
        'preserve-domains',
        '---\nname: preserve-domains\ndescription: Old\n---\n# Old',
        createTestPolicy({ domains: ['old.example.com'] })
      );

      await writeSkillMd('preserve-domains', 'Updated version', '# Updated');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['preserve-domains']);

      const installedDir = join(skillsDir, 'preserve-domains');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.status).toBe('pending_review');
      expect(policy.domains).toEqual(['old.example.com']);
    });

    it('new skill has no domains (set during approval)', async () => {
      await writeSkillMd('new-skill-domains', 'Brand new skill');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['new-skill-domains']);

      const installedDir = join(skillsDir, 'new-skill-domains');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.domains).toBeUndefined();
    });
  });

  describe('contentHash', () => {
    it('stamps contentHash in policy.provenance for new skills', async () => {
      await writeSkillMd('hash-new', 'A skill to test content hashing');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['hash-new']);

      const installedDir = join(skillsDir, 'hash-new');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.provenance).toBeDefined();
      expect(policy.provenance.contentHash).toMatch(/^sha256:/);
    });

    it('stamps contentHash in policy.provenance for updated skills', async () => {
      await preInstallSkill(
        'hash-update',
        '---\nname: hash-update\ndescription: Old\n---\n# Old',
        createTestPolicy()
      );

      // Modify workspace so extraction triggers
      await writeSkillMd('hash-update', 'Updated hash skill', '# Modified content');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['hash-update']);

      const installedDir = join(skillsDir, 'hash-update');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.provenance).toBeDefined();
      expect(policy.provenance.contentHash).toMatch(/^sha256:/);
    });
  });

  describe('changedFiles and deletedFiles', () => {
    it('populates changedFiles when files are modified', async () => {
      await preInstallSkill(
        'diff-changed',
        '---\nname: diff-changed\ndescription: Diff test\n---\n# Original',
        createTestPolicy()
      );

      // Set up workspace with initial content and generate baseline
      await writeSkillMd('diff-changed', 'Diff test', '# Original');
      await writeBaseline();

      // Modify SKILL.md after baseline
      await writeSkillMd('diff-changed', 'Diff test', '# Modified after baseline');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['diff-changed']);

      const installedDir = join(skillsDir, 'diff-changed');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.extractedFrom.changedFiles).toContain('SKILL.md');
    });

    it('populates deletedFiles when files are removed', async () => {
      await preInstallSkill(
        'diff-deleted',
        '---\nname: diff-deleted\ndescription: Diff delete test\n---\n# Skill',
        createTestPolicy()
      );

      // Set up workspace with SKILL.md + references/api.md
      await writeSkillMd('diff-deleted', 'Diff delete test');
      await mkdir(join(workspace, 'references'), { recursive: true });
      await writeFile(join(workspace, 'references', 'api.md'), '# API Docs', 'utf-8');
      await writeBaseline();

      // Delete references/api.md after baseline
      await rm(join(workspace, 'references', 'api.md'));

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['diff-deleted']);

      const installedDir = join(skillsDir, 'diff-deleted');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.extractedFrom.deletedFiles).toContain('references/api.md');
    });
  });

  describe('delete semantics', () => {
    it('removes deleted files from installed skill', async () => {
      // Pre-install a skill with an extra file (scripts/old.sh)
      const installedDir = await preInstallSkill(
        'clean-replace',
        '---\nname: clean-replace\ndescription: Clean replacement test\n---\n# Old',
        createTestPolicy()
      );
      await mkdir(join(installedDir, 'scripts'), { recursive: true });
      await writeFile(join(installedDir, 'scripts', 'old.sh'), '#!/bin/bash\necho old', 'utf-8');

      // Set up workspace with only SKILL.md (no scripts/old.sh)
      // No baseline = treated as new skill creation = rm + mkdir + cp
      await writeSkillMd('clean-replace', 'Clean replacement test', '# New version');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      // Has existing policy so it counts as update
      expect(result.updated).toEqual(['clean-replace']);

      // Verify scripts/old.sh no longer exists in installed dir
      const oldShPath = join(skillsDir, 'clean-replace', 'scripts', 'old.sh');
      await expect(access(oldShPath)).rejects.toThrow();
    });
  });

  describe('size limits', () => {
    it('skips extraction when file exceeds 1MB', async () => {
      await writeSkillMd('big-file', 'Skill with oversized file');

      // Write a file > 1MB
      const largeContent = Buffer.alloc(1024 * 1024 + 1, 'x');
      await writeFile(join(workspace, 'huge.bin'), largeContent);

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result).toEqual({ created: [], updated: [] });
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('skips extraction when total size exceeds 10MB', async () => {
      await writeSkillMd('many-files', 'Skill with many large files');

      // Write multiple files totaling > 10MB (each under 1MB individually)
      const fileSize = 900 * 1024; // 900KB each
      const fileContent = Buffer.alloc(fileSize, 'y');
      for (let i = 0; i < 12; i++) {
        await writeFile(join(workspace, `data-${String(i)}.bin`), fileContent);
      }

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result).toEqual({ created: [], updated: [] });
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });
});
