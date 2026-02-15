/**
 * Skill Review Service Tests
 *
 * Tests for deterministic security review generation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  reviewSkill,
  extractCredentialReferences,
  extractDomainReferences,
} from '../../../../src/runtime/skills/skill-review.js';
import { loadSkill } from '../../../../src/runtime/skills/skill-loader.js';
import type { LoadedSkill } from '../../../../src/runtime/skills/skill-types.js';
import { createTestPolicy } from '../../../helpers/factories.js';

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
        policy: createTestPolicy({ status: 'pending_review' }),
      });

      const review = await reviewSkill(loaded);

      expect(review.status).toContain('pending_review');
    });

    it('handles missing policy gracefully', async () => {
      const loaded = await createSkill({ name: 'no-policy-skill' });

      const review = await reviewSkill(loaded);

      expect(review.status).toContain('no_policy');
      expect(review.policyDomains).toEqual([]);
      expect(review.policyCredentials).toEqual([]);
    });
  });

  describe('policy extraction', () => {
    it('extracts domains from policy', async () => {
      const loaded = await createSkill({
        name: 'domains-skill',
        policy: createTestPolicy({
          status: 'approved',
          domains: ['api.example.com', 'cdn.example.com'],
        }),
      });

      const review = await reviewSkill(loaded);

      expect(review.policyDomains).toEqual(['api.example.com', 'cdn.example.com']);
    });

    it('extracts requiredCredentials from policy', async () => {
      const loaded = await createSkill({
        name: 'creds-skill',
        policy: createTestPolicy({
          status: 'approved',
          requiredCredentials: ['API_KEY', 'SECRET_TOKEN'],
        }),
      });

      const review = await reviewSkill(loaded);

      expect(review.policyCredentials).toEqual(['API_KEY', 'SECRET_TOKEN']);
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
        policy: createTestPolicy(),
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
        policy: createTestPolicy({ status: 'approved', provenance }),
      });

      const review = await reviewSkill(loaded);

      expect(review.provenance).toEqual(provenance);
    });
  });

  describe('content reference extraction', () => {
    describe('extractCredentialReferences', () => {
      it('extracts process.env.VAR_NAME', () => {
        const text = 'const key = process.env.AGENTMAIL_API_KEY;';
        expect(extractCredentialReferences(text)).toEqual(['AGENTMAIL_API_KEY']);
      });

      it('extracts os.environ["VAR_NAME"]', () => {
        const text = 'key = os.environ["SECRET_TOKEN"]';
        expect(extractCredentialReferences(text)).toEqual(['SECRET_TOKEN']);
      });

      it('extracts os.environ.get("VAR_NAME")', () => {
        const text = 'key = os.environ.get("CLIENT_ID")';
        expect(extractCredentialReferences(text)).toEqual(['CLIENT_ID']);
      });

      it('extracts os.environ["VAR_NAME"] with single quotes', () => {
        const text = "key = os.environ['SINGLE_QUOTED']";
        expect(extractCredentialReferences(text)).toEqual(['SINGLE_QUOTED']);
      });

      it('extracts VAULT_* convention variables', () => {
        const text = 'Use VAULT_SLACK_TOKEN for authentication';
        expect(extractCredentialReferences(text)).toEqual(['VAULT_SLACK_TOKEN']);
      });

      it('extracts ${VAR_NAME} inside bash blocks', () => {
        const text = '```bash\ncurl -H "Authorization: ${API_KEY}" https://api.example.com\n```';
        expect(extractCredentialReferences(text)).toEqual(['API_KEY']);
      });

      it('filters out process.env.NODE_ENV', () => {
        const text = 'if (process.env.NODE_ENV === "production")';
        expect(extractCredentialReferences(text)).toEqual([]);
      });

      it('deduplicates and sorts results', () => {
        const text = `
          process.env.API_KEY
          process.env.API_KEY
          process.env.ZEBRA_KEY
          process.env.ALPHA_KEY
        `;
        expect(extractCredentialReferences(text)).toEqual(['ALPHA_KEY', 'API_KEY', 'ZEBRA_KEY']);
      });

      it('returns empty array for no credential refs', () => {
        const text = 'This is just plain text with no credentials';
        expect(extractCredentialReferences(text)).toEqual([]);
      });

      it('filters out shell specials ($1, $?, $$)', () => {
        const text = '```bash\necho $1\nexit $?\npid=$$\nMY_VAR="value"\necho $MY_VAR\n```';
        expect(extractCredentialReferences(text)).toEqual(['MY_VAR']);
      });

      it('preserves mixed case', () => {
        const text = 'process.env.MyKey';
        expect(extractCredentialReferences(text)).toEqual(['MyKey']);
      });

      it('extracts process.env["VAR_NAME"] bracket notation', () => {
        const text = 'const key = process.env["API_SECRET"];';
        expect(extractCredentialReferences(text)).toEqual(['API_SECRET']);
      });

      it("extracts process.env['VAR_NAME'] single-quote bracket notation", () => {
        const text = "const key = process.env['WEBHOOK_TOKEN'];";
        expect(extractCredentialReferences(text)).toEqual(['WEBHOOK_TOKEN']);
      });

      it('extracts bare $VAR in bash blocks', () => {
        const text = '```bash\ncurl -H "Auth: $AUTH_TOKEN" https://api.test.com\n```';
        expect(extractCredentialReferences(text)).toEqual(['AUTH_TOKEN']);
      });

      it('extracts from ```shell blocks', () => {
        const text = '```shell\nexport ${MY_SECRET}=value\n```';
        expect(extractCredentialReferences(text)).toEqual(['MY_SECRET']);
      });

      it('extracts from multiple bash blocks', () => {
        const text = '```bash\necho $FIRST_KEY\n```\nSome text\n```sh\necho $SECOND_KEY\n```';
        expect(extractCredentialReferences(text)).toEqual(['FIRST_KEY', 'SECOND_KEY']);
      });

      it('does not extract ${VAR} from non-shell code blocks', () => {
        const text = '```python\nprint("${NOT_A_SHELL_VAR}")\n```';
        expect(extractCredentialReferences(text)).toEqual([]);
      });

      it('extracts os.environ.get with default argument', () => {
        const text = 'os.environ.get("API_KEY", "fallback")';
        expect(extractCredentialReferences(text)).toEqual(['API_KEY']);
      });
    });

    describe('extractDomainReferences', () => {
      it('extracts https://api.agentmail.to', () => {
        const text = 'Fetch from https://api.agentmail.to';
        expect(extractDomainReferences(text)).toEqual(['api.agentmail.to']);
      });

      it('strips path from URL', () => {
        const text = 'POST to https://api.agentmail.to/v1/send';
        expect(extractDomainReferences(text)).toEqual(['api.agentmail.to']);
      });

      it('filters out example.com', () => {
        const text = 'See https://example.com for docs';
        expect(extractDomainReferences(text)).toEqual([]);
      });

      it('filters out your-server.com', () => {
        const text = 'Replace https://your-server.com with your domain';
        expect(extractDomainReferences(text)).toEqual([]);
      });

      it('handles trailing punctuation', () => {
        const text = 'API is at (https://api.x.com).';
        expect(extractDomainReferences(text)).toEqual(['api.x.com']);
      });

      it('deduplicates and sorts results', () => {
        const text = `
          https://zebra.com
          https://alpha.com
          https://alpha.com
        `;
        expect(extractDomainReferences(text)).toEqual(['alpha.com', 'zebra.com']);
      });

      it('filters out localhost', () => {
        const text = 'Test locally at https://localhost:3000';
        expect(extractDomainReferences(text)).toEqual([]);
      });

      it('returns empty array for no URL refs', () => {
        const text = 'No URLs here';
        expect(extractDomainReferences(text)).toEqual([]);
      });

      it('normalizes to lowercase', () => {
        const text = 'https://API.Example.COM/test';
        // Note: example.com is filtered, so let's use a real-looking domain
        const text2 = 'https://API.RealService.COM/test';
        expect(extractDomainReferences(text2)).toEqual(['api.realservice.com']);
      });

      it('extracts HTTP URLs (not just HTTPS)', () => {
        const text = 'Endpoint at http://api.internal.corp/v1';
        expect(extractDomainReferences(text)).toEqual(['api.internal.corp']);
      });

      it('extracts URL with port number', () => {
        const text = 'Server at https://api.myapp.com:8443/path';
        expect(extractDomainReferences(text)).toEqual(['api.myapp.com']);
      });
    });

    describe('integration: full skill review', () => {
      it('populates referencedCredentials and referencedDomains from skill body', async () => {
        const loaded = await createSkill({
          name: 'agentmail-test',
          description: 'AgentMail API skill',
          policy: createTestPolicy({ status: 'pending_review' }),
        });

        // Modify the skill body to include references
        const skillPath = join(skillDir, 'agentmail-test', 'SKILL.md');
        await writeFile(
          skillPath,
          `---
name: agentmail-test
description: AgentMail API skill
---
# AgentMail

Send emails using the AgentMail API.

\`\`\`bash
curl -H "Authorization: Bearer \${AGENTMAIL_API_KEY}" https://api.agentmail.to/v1/send
\`\`\`

Also see https://console.agentmail.to for dashboard access.
`,
          'utf-8'
        );

        // Reload the skill
        const reloaded = await loadSkill('agentmail-test', skillDir);
        if ('error' in reloaded) {
          throw new Error(`Failed to reload skill: ${reloaded.error}`);
        }

        const review = await reviewSkill(reloaded);

        expect(review.referencedCredentials).toContain('AGENTMAIL_API_KEY');
        expect(review.referencedDomains).toEqual(
          expect.arrayContaining(['api.agentmail.to', 'console.agentmail.to'])
        );
      });

      it('extracts references from scripts/ and references/ files', async () => {
        const loaded = await createSkill({
          name: 'multi-file-skill',
          description: 'Skill with references in multiple files',
          policy: createTestPolicy({ status: 'pending_review' }),
          files: [
            {
              path: 'scripts/setup.sh',
              content: '#!/bin/bash\ncurl -H "Authorization: $SETUP_TOKEN" https://setup.api.io/init\n',
            },
            {
              path: 'references/config.md',
              content: '# Config\nSet `process.env.REF_API_KEY` to your key.\nEndpoint: https://ref.service.com/v2\n',
            },
          ],
        });

        const review = await reviewSkill(loaded);

        // Credentials from scripts/ and references/ should be found
        expect(review.referencedCredentials).toContain('REF_API_KEY');
        // Domains from scripts/ and references/ should be found
        expect(review.referencedDomains).toContain('setup.api.io');
        expect(review.referencedDomains).toContain('ref.service.com');
      });
    });
  });
});
