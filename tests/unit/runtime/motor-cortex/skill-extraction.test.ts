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
    it('extracts new skill with SKILL.md at workspace root (workspace policy.json ignored)', async () => {
      await writeSkillMd('weather', 'Fetch weather data from wttr.in');
      // Note: policy.json in workspace is now ignored (excluded from allowlist)
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
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
      // Workspace policy.json is ignored, so these fields are not set
      expect(policy.allowedDomains).toBeUndefined();
      expect(policy.provenance).toBeUndefined();
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
        allowedDomains: ['api.example.com'],
      });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['approved-skill']);

      const installedDir = join(skillsDir, 'approved-skill');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
    });
  });

  describe('content hash', () => {
    it('computes hash over installed directory (workspace policy.json ignored)', async () => {
      await writeSkillMd('hashed', 'Hash test');
      await mkdir(join(workspace, 'scripts'), { recursive: true });
      await writeFile(join(workspace, 'scripts', 'run.sh'), 'echo test', 'utf-8');
      // Note: workspace policy.json is ignored, so no provenance/contentHash
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        provenance: { source: 'test', fetchedAt: '2024-01-01T00:00:00Z' },
      });

      await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      const installedDir = join(skillsDir, 'hashed');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      // No provenance since workspace policy.json is ignored
      expect(policy.provenance).toBeUndefined();

      // Verify directory hash can still be computed
      const directHash = await computeDirectoryHash(installedDir);
      expect(directHash).toMatch(/^sha256:/);
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
    it('workspace policy.json is ignored (no provenance preserved)', async () => {
      await writeSkillMd('provenance', 'Provenance test');
      // Note: workspace policy.json is now ignored (excluded from allowlist)
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        allowedDomains: ['api.example.com'],
        provenance: {
          source: 'https://example.com/docs',
          fetchedAt: '2024-01-01T00:00:00Z',
        },
      });

      await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      const installedDir = join(skillsDir, 'provenance');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      // No provenance since workspace policy.json is ignored
      expect(policy.provenance).toBeUndefined();
      expect(policy.allowedDomains).toBeUndefined();
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
      await writePolicy({ schemaVersion: 'wrong', trust: 'approved' });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['wrong-schema']);

      const installedDir = join(skillsDir, 'wrong-schema');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.schemaVersion).toBe(1);
      expect(policy.trust).toBe('pending_review');
    });
  });

  describe('credential persistence through extraction', () => {
    it('preserves existing credentialValues when updating a skill', async () => {
      // Pre-install skill with credentials in policy
      const installedDir = join(skillsDir, 'with-creds');
      await mkdir(installedDir, { recursive: true });
      await writeFile(
        join(installedDir, 'SKILL.md'),
        '---\nname: with-creds\ndescription: Has credentials\n---\n# Old',
        'utf-8'
      );
      await writeFile(
        join(installedDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'approved',
          requiredCredentials: ['api_key'],
          credentialValues: { api_key: 'sk-live-secret-12345' },
        }),
        'utf-8'
      );

      // Write updated SKILL.md (triggers extraction)
      await writeSkillMd('with-creds', 'Has credentials', '# Updated instructions');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['with-creds']);

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review'); // Trust always reset
      expect(policy.credentialValues).toEqual({ api_key: 'sk-live-secret-12345' }); // Preserved!
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
      // Pre-install skill with existing credential
      const installedDir = join(skillsDir, 'merge-test');
      await mkdir(installedDir, { recursive: true });
      await writeFile(
        join(installedDir, 'SKILL.md'),
        '---\nname: merge-test\ndescription: Merge test\n---\n# Old',
        'utf-8'
      );
      await writeFile(
        join(installedDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'approved',
          credentialValues: { old_key: 'old-value', shared_key: 'old-shared' },
        }),
        'utf-8'
      );

      // Update skill with new pending credentials
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

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.credentialValues).toEqual({
        old_key: 'old-value', // Preserved from existing
        shared_key: 'new-shared', // Pending wins over existing
        new_key: 'new-value', // New from pending
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

    it('preserves existing policy values on update (policy.json excluded from workspace)', async () => {
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
        JSON.stringify({ schemaVersion: 1, trust: 'approved', allowedDomains: ['old.example.com'] }),
        'utf-8'
      );

      // Write updated version at workspace root
      await writeSkillMd('motor-wins', 'Updated version', '# Updated');
      // Note: policy.json in workspace is now ignored (not in allowlist)
      await writePolicy({
        schemaVersion: 1,
        trust: 'approved',
        allowedDomains: ['new.example.com'],
      });

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['motor-wins']);

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.trust).toBe('pending_review');
      // Existing policy values are preserved since workspace policy.json is excluded
      expect(policy.allowedDomains).toEqual(['old.example.com']);
    });
  });

  describe('frontmatter inputs pipeline', () => {
    it('extracts inputs from SKILL.md frontmatter to policy.json', async () => {
      const skillContent = `---
name: send-email
description: Send emails via Resend API
inputs:
  - name: RESEND_API_KEY
    description: Resend API key for sending emails
    required: true
  - name: TIMEOUT_MS
    type: number
    description: Timeout in milliseconds
    required: false
    default: 5000
---
# Send Email
Instructions here`;
      await writeFile(join(workspace, 'SKILL.md'), skillContent, 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['send-email']);

      const installedDir = join(skillsDir, 'send-email');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      expect(policy.inputs).toBeDefined();
      expect(policy.inputs).toHaveLength(2);
      expect(policy.inputs?.[0]).toEqual({
        name: 'RESEND_API_KEY',
        type: 'string',
        description: 'Resend API key for sending emails',
        required: true,
      });
      expect(policy.inputs?.[1]).toEqual({
        name: 'TIMEOUT_MS',
        type: 'number',
        description: 'Timeout in milliseconds',
        required: false,
        default: 5000,
      });
    });

    it('uses frontmatter inputs over existing policy inputs on update', async () => {
      // Pre-install with old inputs
      const installedDir = join(skillsDir, 'input-update');
      await mkdir(installedDir, { recursive: true });
      await writeFile(
        join(installedDir, 'SKILL.md'),
        '---\nname: input-update\ndescription: Old\n---\n# Old',
        'utf-8'
      );
      await writeFile(
        join(installedDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'approved',
          inputs: [{ name: 'OLD_INPUT', type: 'string', description: 'Old', required: true }],
        }),
        'utf-8'
      );

      // Update with new inputs in frontmatter
      const skillContent = `---
name: input-update
description: Updated
inputs:
  - name: NEW_INPUT
    type: boolean
    description: New input
    required: false
---
# Updated`;
      await writeFile(join(workspace, 'SKILL.md'), skillContent, 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.updated).toEqual(['input-update']);

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      // Frontmatter inputs take precedence
      expect(policy.inputs).toHaveLength(1);
      expect(policy.inputs?.[0]?.name).toBe('NEW_INPUT');
      expect(policy.inputs?.[0]?.type).toBe('boolean');
    });

    it('falls back to existing inputs when frontmatter has no inputs', async () => {
      // Pre-install with inputs
      const installedDir = join(skillsDir, 'input-fallback');
      await mkdir(installedDir, { recursive: true });
      await writeFile(
        join(installedDir, 'SKILL.md'),
        '---\nname: input-fallback\ndescription: Old\n---\n# Old',
        'utf-8'
      );
      await writeFile(
        join(installedDir, 'policy.json'),
        JSON.stringify({
          schemaVersion: 1,
          trust: 'approved',
          inputs: [{ name: 'EXISTING', type: 'string', description: 'Existing input', required: true }],
        }),
        'utf-8'
      );

      // Update without inputs in frontmatter
      await writeSkillMd('input-fallback', 'Updated', '# Updated');

      await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);

      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      // Existing inputs preserved
      expect(policy.inputs).toHaveLength(1);
      expect(policy.inputs?.[0]?.name).toBe('EXISTING');
    });

    it('handles malformed inputs gracefully', async () => {
      const skillContent = `---
name: bad-inputs
description: Has malformed inputs
inputs:
  - description: Missing name
  - name: ""
    description: Empty name
  - name: VALID
    type: invalid_type
    description: Valid entry with bad type
---
# Skill`;
      await writeFile(join(workspace, 'SKILL.md'), skillContent, 'utf-8');

      const result = await extractSkillsFromWorkspace(workspace, skillsDir, runId, mockLogger);
      expect(result.created).toEqual(['bad-inputs']);

      const installedDir = join(skillsDir, 'bad-inputs');
      const policy = JSON.parse(await readFile(join(installedDir, 'policy.json'), 'utf-8'));
      // Only VALID entry should be included, with defaulted type
      expect(policy.inputs).toHaveLength(1);
      expect(policy.inputs?.[0]?.name).toBe('VALID');
      expect(policy.inputs?.[0]?.type).toBe('string'); // defaulted from invalid type
    });
  });
});
