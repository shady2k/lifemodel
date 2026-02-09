/**
 * Unit tests for Skill Loader: SKILL.md parsing, validation, discovery.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import {
  parseSkillFile,
  validateSkillDefinition,
  loadSkill,
  discoverSkills,
  validateSkillInputs,
} from '../../../src/runtime/skills/skill-loader.js';
import type { LoadedSkill } from '../../../src/runtime/skills/skill-types.js';

describe('parseSkillFile', () => {
  it('parses valid SKILL.md with frontmatter and body', () => {
    const content = `---
name: agentmail
version: 1
description: Send emails via AgentMail API
tools: [shell, code, filesystem]
credentials: [agentmail_api_key]
---
# AgentMail Skill

Use curl to call the AgentMail API.`;

    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.definition['name']).toBe('agentmail');
      expect(result.definition['version']).toBe(1);
      expect(result.definition['tools']).toEqual(['shell', 'code', 'filesystem']);
      expect(result.definition['credentials']).toEqual(['agentmail_api_key']);
      expect(result.body).toContain('# AgentMail Skill');
    }
  });

  it('parses boolean values', () => {
    const content = `---
name: test
version: 1
tools: [code]
enabled: true
disabled: false
---
Body`;

    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.definition['enabled']).toBe(true);
      expect(result.definition['disabled']).toBe(false);
    }
  });

  it('parses quoted strings', () => {
    const content = `---
name: test
version: 1
tools: [code]
description: "A skill with spaces"
---
Body`;

    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.definition['description']).toBe('A skill with spaces');
    }
  });

  it('returns error for missing opening delimiter', () => {
    const result = parseSkillFile('No frontmatter here');
    expect('error' in result).toBe(true);
  });

  it('returns error for missing closing delimiter', () => {
    const result = parseSkillFile('---\nname: test\n');
    expect('error' in result).toBe(true);
  });

  it('handles empty arrays', () => {
    const content = `---
name: test
version: 1
tools: []
---
Body`;

    const result = parseSkillFile(content);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.definition['tools']).toEqual([]);
    }
  });
});

describe('validateSkillDefinition', () => {
  it('validates a correct definition', () => {
    const errors = validateSkillDefinition({
      name: 'my-skill',
      version: 1,
      description: 'A skill',
      tools: ['code', 'shell'],
    });
    expect(errors).toEqual([]);
  });

  it('rejects missing name', () => {
    const errors = validateSkillDefinition({
      version: 1,
      tools: ['code'],
    });
    expect(errors.some((e) => e.includes('name'))).toBe(true);
  });

  it('rejects invalid name format', () => {
    const errors = validateSkillDefinition({
      name: 'Has Spaces',
      version: 1,
      tools: ['code'],
    });
    expect(errors.some((e) => e.includes('lowercase'))).toBe(true);
  });

  it('rejects missing version', () => {
    const errors = validateSkillDefinition({
      name: 'test',
      tools: ['code'],
    });
    expect(errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('rejects empty tools', () => {
    const errors = validateSkillDefinition({
      name: 'test',
      version: 1,
      tools: [],
    });
    expect(errors.some((e) => e.includes('tools'))).toBe(true);
  });

  it('rejects invalid tool names', () => {
    const errors = validateSkillDefinition({
      name: 'test',
      version: 1,
      tools: ['invalid_tool'],
    });
    expect(errors.some((e) => e.includes('Invalid tool'))).toBe(true);
  });
});

describe('loadSkill', () => {
  let skillsDir: string;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'motor-skills-'));
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('loads a valid skill', async () => {
    await mkdir(join(skillsDir, 'test-skill'));
    await writeFile(
      join(skillsDir, 'test-skill', 'SKILL.md'),
      `---
name: test-skill
version: 1
description: A test skill
tools: [code, shell]
---
# Test Skill
Do stuff.`
    );

    const result = await loadSkill('test-skill', skillsDir);
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.definition.name).toBe('test-skill');
      expect(result.definition.tools).toEqual(['code', 'shell']);
      expect(result.body).toContain('# Test Skill');
    }
  });

  it('returns error for missing skill', async () => {
    const result = await loadSkill('nonexistent', skillsDir);
    expect('error' in result).toBe(true);
  });

  it('returns error for invalid frontmatter', async () => {
    await mkdir(join(skillsDir, 'bad'));
    await writeFile(join(skillsDir, 'bad', 'SKILL.md'), 'No frontmatter');

    const result = await loadSkill('bad', skillsDir);
    expect('error' in result).toBe(true);
  });
});

describe('discoverSkills', () => {
  let skillsDir: string;

  beforeEach(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), 'motor-skills-'));
  });

  afterEach(async () => {
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('discovers skills with SKILL.md files', async () => {
    await mkdir(join(skillsDir, 'skill-a'));
    await writeFile(join(skillsDir, 'skill-a', 'SKILL.md'), '---\nname: a\n---\n');
    await mkdir(join(skillsDir, 'skill-b'));
    await writeFile(join(skillsDir, 'skill-b', 'SKILL.md'), '---\nname: b\n---\n');
    await mkdir(join(skillsDir, 'no-skill')); // No SKILL.md

    const skills = await discoverSkills(skillsDir);
    expect(skills).toEqual(['skill-a', 'skill-b']);
  });

  it('returns empty array for non-existent dir', async () => {
    const skills = await discoverSkills('/tmp/nonexistent-skills-dir');
    expect(skills).toEqual([]);
  });
});

describe('validateSkillInputs', () => {
  const skill: LoadedSkill = {
    definition: {
      name: 'test',
      version: 1,
      description: 'Test',
      tools: ['code'],
      inputs: [
        { name: 'to', type: 'string', description: 'Recipient', required: true },
        { name: 'count', type: 'number', description: 'Count', required: false, default: 1 },
      ],
    },
    body: 'Body',
    path: '/test/SKILL.md',
  };

  it('passes valid inputs', () => {
    const errors = validateSkillInputs(skill, { to: 'user@example.com', count: 5 });
    expect(errors).toEqual([]);
  });

  it('rejects missing required input', () => {
    const errors = validateSkillInputs(skill, { count: 5 });
    expect(errors.some((e) => e.includes('to'))).toBe(true);
  });

  it('rejects wrong type', () => {
    const errors = validateSkillInputs(skill, { to: 123 });
    expect(errors.some((e) => e.includes('string'))).toBe(true);
  });

  it('warns about unknown inputs', () => {
    const errors = validateSkillInputs(skill, { to: 'test', unknown: 'value' });
    expect(errors.some((e) => e.includes('Unknown'))).toBe(true);
  });
});
