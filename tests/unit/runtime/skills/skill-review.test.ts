/**
 * Skill Review Service Tests
 *
 * Tests for deterministic security review generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { reviewSkill } from '../../../../src/runtime/skills/skill-review.js';
import { loadSkill } from '../../../../src/runtime/skills/skill-loader.js';
import type { LoadedSkill } from '../../../../src/runtime/skills/skill-types.js';

describe('skill-review', () => {
  let skillDir: string;

  beforeEach(async () => {
    const base = tmpdir();
    skillDir = join(base, `.test-skill-review-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(skillDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(skillDir, { recursive: true, force: true });
  });

  async function createSkill(options: {
    name: string;
    description?: string;
    policy?: Record<string, unknown>;
    files?: Array<{ path: string; content: string }>;
  }): Promise<LoadedSkill> {
    // loadSkill expects skill at skillsDir/name/SKILL.md
    const thisSkillDir = join(skillDir, options.name);
    await mkdir(thisSkillDir, { recursive: true });

    const description = options.description ?? `Skill ${options.name}`;
    await writeFile(
      join(thisSkillDir, 'SKILL.md'),
      `---\nname: ${options.name}\ndescription: ${description}\n---\n# ${options.name}\n\nInstructions here.`,
      'utf-8'
    );

    if (options.policy) {
      await writeFile(join(thisSkillDir, 'policy.json'), JSON.stringify(options.policy), 'utf-8');
    }

    if (options.files) {
      for (const file of options.files) {
        const filePath = join(thisSkillDir, file.path);
        const dir = join(thisSkillDir, file.path.split('/').slice(0, -1).join('/'));
        if (dir !== thisSkillDir) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(filePath, file.content, 'utf-8');
      }
    }

    const loaded = await loadSkill(options.name, skillDir);
    if ('error' in loaded) {
      throw new Error(`Failed to load skill: ${loaded.error}`);
    }
    return loaded;
  }

  describe('basic review', () => {
    it('returns skill name and description', async () => {
      const loaded = await createSkill({
        name: 'test-skill',
        description: 'A test skill for review',
      });

      const review = await reviewSkill(loaded);

      expect(review.name).toBe('test-skill');
      expect(review.description).toBe('A test skill for review');
    });

    it('returns trust interpretation', async () => {
      const loaded = await createSkill({
        name: 'pending-skill',
        policy: { schemaVersion: 1, trust: 'pending_review' },
      });

      const review = await reviewSkill(loaded);

      expect(review.trust).toContain('pending_review');
    });

    it('handles missing policy gracefully', async () => {
      const loaded = await createSkill({ name: 'no-policy-skill' });

      const review = await reviewSkill(loaded);

      expect(review.trust).toContain('no_policy');
      expect(review.policyDomains).toEqual([]);
      expect(review.policyCredentials).toEqual([]);
    });
  });

  describe('policy extraction', () => {
    it('extracts allowedDomains from policy', async () => {
      const loaded = await createSkill({
        name: 'domains-skill',
        policy: {
          schemaVersion: 1,
          trust: 'approved',
          allowedDomains: ['api.example.com', 'cdn.example.com'],
        },
      });

      const review = await reviewSkill(loaded);

      expect(review.policyDomains).toEqual(['api.example.com', 'cdn.example.com']);
    });

    it('extracts requiredCredentials from policy', async () => {
      const loaded = await createSkill({
        name: 'creds-skill',
        policy: {
          schemaVersion: 1,
          trust: 'approved',
          requiredCredentials: ['API_KEY', 'SECRET_TOKEN'],
        },
      });

      const review = await reviewSkill(loaded);

      expect(review.policyCredentials).toEqual(['API_KEY', 'SECRET_TOKEN']);
    });
  });

  describe('run evidence', () => {
    it('returns null evidence when not in policy', async () => {
      const loaded = await createSkill({
        name: 'no-evidence-skill',
        policy: { schemaVersion: 1, trust: 'approved' },
      });

      const review = await reviewSkill(loaded);

      expect(review.evidence).toBeNull();
    });

    it('returns evidence from policy', async () => {
      const evidence = {
        fetchedDomains: ['api.github.com', 'raw.githubusercontent.com'],
        savedCredentials: ['GITHUB_TOKEN'],
        toolsUsed: ['fetch', 'write', 'bash'],
        bashUsed: true,
      };
      const loaded = await createSkill({
        name: 'evidence-skill',
        policy: {
          schemaVersion: 1,
          trust: 'pending_review',
          runEvidence: evidence,
        },
      });

      const review = await reviewSkill(loaded);

      expect(review.evidence).toEqual(evidence);
    });
  });

  describe('file inventory', () => {
    it('scans skill files', async () => {
      const loaded = await createSkill({
        name: 'files-skill',
        files: [
          { path: 'scripts/run.sh', content: '#!/bin/bash\necho hello' },
          { path: 'references/api.md', content: '# API Docs' },
        ],
      });

      const review = await reviewSkill(loaded);

      expect(review.files.length).toBeGreaterThan(0);
      // SKILL.md should be included
      expect(review.files.some((f) => f.path === 'SKILL.md')).toBe(true);
      // Should have hash and size
      for (const file of review.files) {
        expect(file.hash).toMatch(/^[a-f0-9]+$/);
        expect(file.sizeBytes).toBeGreaterThan(0);
      }
    });

    it('excludes policy.json from inventory', async () => {
      const loaded = await createSkill({
        name: 'policy-exclude-skill',
        policy: { schemaVersion: 1, trust: 'approved' },
      });

      const review = await reviewSkill(loaded);

      expect(review.files.some((f) => f.path === 'policy.json')).toBe(false);
    });
  });

  describe('provenance', () => {
    it('returns provenance from policy', async () => {
      const provenance = {
        source: 'https://github.com/example/skill',
        fetchedAt: '2024-01-15T10:30:00Z',
        contentHash: 'sha256:abc123',
      };
      const loaded = await createSkill({
        name: 'provenance-skill',
        policy: {
          schemaVersion: 1,
          trust: 'approved',
          provenance,
        },
      });

      const review = await reviewSkill(loaded);

      expect(review.provenance).toEqual(provenance);
    });
  });
});
