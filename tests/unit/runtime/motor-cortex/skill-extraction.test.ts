/**
 * Skill Extraction Tests
 *
 * Tests for extractSkillsFromWorkspace() covering:
 * - Empty workspace (no SKILL.md)
 * - New skill creation (no baseline, SKILL.md at root)
 * - Existing skill with baseline-diff (unchanged = skip, changed = extract)
 * - Policy handling (Motor policy, no policy, invalid policy)
 * - Symlink rejection
 * - Size limits
 * - Trust forced to "pending_review"
 * - Content hash computed
 * - Provenance preserved
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, writeFile, readFile, symlink, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  extractSkillsFromWorkspace,
  generateBaseline,
} from '../../../../src/runtime/motor-cortex/skill-extraction.js';
import { computeDirectoryHash } from '../../../../src/runtime/skills/skill-loader.js';

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
    workspace = join(base, `.test-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    skillsDir = join(base, `.test-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  /** Helper: write policy.json at workspace root */
  async function writePolicy(policy: Record<string, unknown>): Promise<void> {
    await writeFile(join(workspace, 'policy.json'), JSON.stringify(policy), 'utf-8');
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

  /** Helper: write an empty baseline (simulates fresh workspace with no pre-existing skill files) */
  async function writeEmptyBaseline(): Promise<void> {
    await writeFile(
      join(workspace, '.motor-baseline.json'),
      JSON.stringify({ files: {} }),
      'utf-8'
    );
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
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        allowedTools: ['bash'],
        allowedDomains: ['wttr.in'],
        provenance: { source: 'https://wttr.in', fetchedAt: new Date().toISOString() },
      });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['weather']);
      expect(result.updated).toEqual([]);

      // Verify installed
      const installedDir = join(skillsDir, 'weather');
      const skillMd = await readFile(join(installedDir, 'SKILL.md'), 'utf-8');
      expect(skillMd).toContain('name: weather');

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      expect(policy.allowedDomains).toEqual(['wttr.in']);
      expect(policy.provenance.source).toBe('https://wttr.in');
      expect(policy.extractedFrom.runId).toBe(runId);
    });

    it('extracts new skill without policy.json and generates minimal policy', async () => {
      await writeSkillMd('hello', 'Say hello to the world');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual(['hello']);

      const installedDir = join(skillsDir, 'hello');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      expect(policy.schemaVersion).toBe(1);
      expect(policy.allowedTools).toEqual([]);
      expect(policy.extractedFrom.runId).toBe(runId);
    });
  });

  describe('baseline-diff extraction (existing skill)', () => {
    it('skips extraction when no changes detected', async () => {
      // Simulate: skill copied to workspace, baseline generated, no edits
      await writeSkillMd('existing', 'An existing skill');
      await writeBaseline();

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(result.updated).toEqual([]);
    });

    it('extracts when SKILL.md is modified after baseline', async () => {
      // Pre-install the skill so it counts as update
      const installedDir = join(skillsDir, 'existing');
      await mkdir(installedDir, { recursive: true });
      await writeFile(join(installedDir, 'SKILL.md'), '---\nname: existing\ndescription: Old\n---\n# Old', 'utf-8');

      // Simulate: skill copied, baseline generated
      await writeSkillMd('existing', 'An existing skill', '# Original');
      await writeBaseline();

      // Agent modifies SKILL.md
      await writeSkillMd('existing', 'An existing skill', '# Updated with fixes');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.updated).toEqual(['existing']);

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

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual([]);
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

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual([]);
    });
  });

  describe('size limits', () => {
    it('rejects skill with SKILL.md over 1MB', async () => {
      // Write an oversized SKILL.md (skill files are allowlisted, non-skill files are ignored)
      const largeBody = 'x'.repeat(1024 * 1024 + 1);
      await writeSkillMd('large-file', 'Has large body', largeBody);

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual([]);
    });
  });

  describe('trust forced to pending_review', () => {
    it('forces trust to pending_review even if Motor wrote approved', async () => {
      await writeSkillMd('approved-skill', 'Motor wrote approved');
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        allowedTools: ['bash'],
      });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['approved-skill']);

      const installedDir = join(skillsDir, 'approved-skill');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
    });
  });

  describe('content hash', () => {
    it('computes hash over installed directory', async () => {
      await writeSkillMd('hashed', 'Hash test');
      await mkdir(join(workspace, 'scripts'), { recursive: true });
      await writeFile(join(workspace, 'scripts', 'run.sh'), 'echo test', 'utf-8');
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        allowedTools: [],
        provenance: { source: 'test', fetchedAt: '2024-01-01T00:00:00Z' },
      });

      await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      const installedDir = join(skillsDir, 'hashed');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.provenance.contentHash).toMatch(/^sha256:/);

      const directHash = await computeDirectoryHash(installedDir);
      expect(policy.provenance.contentHash).toBe(directHash);
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

  describe('Motor provenance', () => {
    it('preserves valid Motor provenance', async () => {
      await writeSkillMd('provenance', 'Provenance test');
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        allowedTools: ['bash'],
        provenance: {
          source: 'https://example.com/docs',
          fetchedAt: '2024-01-01T00:00:00Z',
        },
      });

      await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      const installedDir = join(skillsDir, 'provenance');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.provenance.source).toBe('https://example.com/docs');
      expect(policy.provenance.fetchedAt).toBe('2024-01-01T00:00:00Z');
      expect(policy.provenance.contentHash).toBeDefined();
    });
  });

  describe('invalid Motor policy.json', () => {
    it('generates minimal policy when Motor policy is invalid JSON', async () => {
      await writeSkillMd('bad-policy', 'Bad policy');
      await writeFile(join(workspace, 'policy.json'), '{ invalid json', 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['bad-policy']);

      const installedDir = join(skillsDir, 'bad-policy');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      expect(policy.schemaVersion).toBe(1);
    });

    it('generates minimal policy when Motor policy has wrong schema version', async () => {
      await writeSkillMd('wrong-schema', 'Wrong schema');
      await writePolicy({ schemaVersion: 'wrong', trust: 'approved', allowedTools: [] });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['wrong-schema']);

      const installedDir = join(skillsDir, 'wrong-schema');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.schemaVersion).toBe(1);
      expect(policy.trust).toBe('pending_review');
    });
  });

  describe('existing skill update', () => {
    it('marks existing skill as updated', async () => {
      // Pre-install old version
      const installedDir = join(skillsDir, 'existing');
      await mkdir(installedDir, { recursive: true });
      await writeFile(
        join(installedDir, 'SKILL.md'),
        '---\nname: existing\ndescription: Old version\n---\n# Old',
        'utf-8'
      );

      // Write new version at workspace root
      await writeSkillMd('existing', 'Updated version', '# Updated');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      expect(result.created).toEqual([]);
      expect(result.updated).toEqual(['existing']);

      const updatedContent = await readFile(join(installedDir, 'SKILL.md'), 'utf-8');
      expect(updatedContent).toContain('Updated version');
    });

    it('Motor-written policy takes precedence over existing policy on update', async () => {
      // Pre-install with old policy
      const installedDir = join(skillsDir, 'motor-wins');
      await mkdir(installedDir, { recursive: true });
      await writeFile(
        join(installedDir, 'SKILL.md'),
        '---\nname: motor-wins\ndescription: Old\n---\n# Old',
        'utf-8'
      );
      await writeFile(
        join(installedDir, 'policy.json'),
        JSON.stringify({ schemaVersion: 1, trust: 'approved', allowedTools: ['bash'], allowedDomains: ['old.example.com'] }),
        'utf-8'
      );

      // Write updated version at workspace root
      await writeSkillMd('motor-wins', 'Updated version', '# Updated');
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        allowedTools: ['fetch'],
        allowedDomains: ['new.example.com'],
      });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['motor-wins']);

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      expect(policy.allowedTools).toEqual(['fetch']);
      expect(policy.allowedDomains).toEqual(['new.example.com']);
    });
  });
});
