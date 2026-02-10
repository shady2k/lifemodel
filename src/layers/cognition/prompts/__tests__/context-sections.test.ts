/**
 * Tests for context-sections.ts
 *
 * Validates: buildAvailableSkillsSection() with trust states, empty state
 */

import { describe, it, expect } from 'vitest';
import { buildAvailableSkillsSection } from '../context-sections.js';
import type { LoopContext } from '../../agentic-loop-types.js';

describe('buildAvailableSkillsSection', () => {
  function createMockContext(override?: Partial<LoopContext>): LoopContext {
    return {
      triggerSignal: { type: 'user_message', id: 'test', data: { text: 'test' } },
      agentState: {
        energy: 0.5,
        socialDebt: 0,
        taskPressure: 0,
        curiosity: 0.5,
        acquaintancePressure: 0,
      },
      conversationHistory: [],
      userModel: {},
      tickId: 'test-tick',
      ...override,
    } as LoopContext;
  }

  it('returns null when no skills available', () => {
    const context = createMockContext({ availableSkills: undefined });
    const result = buildAvailableSkillsSection(context);
    expect(result).toBeNull();
  });

  it('returns null when skills array is empty', () => {
    const context = createMockContext({ availableSkills: [] });
    const result = buildAvailableSkillsSection(context);
    expect(result).toBeNull();
  });

  it('builds section with approved skills', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'web-scraper', description: 'Email skill', trust: 'approved', hasPolicy: true },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).not.toBeNull();
    expect(result).toContain('<available_skills>');
    expect(result).toContain('web-scraper [approved]');
    expect(result).toContain('Email skill');
    expect(result).toContain('Use core.act with skill parameter');
  });

  it('builds section with unknown trust skills', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'weather', description: 'Weather skill', trust: 'unknown', hasPolicy: false },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).not.toBeNull();
    expect(result).toContain('weather [unknown]');
    expect(result).toContain('(needs onboarding)');
  });

  it('builds section with mixed trust states', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'web-scraper', description: 'Email skill', trust: 'approved', hasPolicy: true },
        { name: 'weather', description: 'Weather skill', trust: 'unknown', hasPolicy: false },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).toContain('web-scraper [approved]');
    expect(result).toContain('weather [unknown]');
    expect(result).toContain('(needs onboarding)');
  });

  it('includes XML tags', () => {
    const context = createMockContext({
      availableSkills: [{ name: 'test', description: 'Test', trust: 'approved', hasPolicy: true }],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).toContain('<available_skills>');
    expect(result?.endsWith('</available_skills>')).toBe(true);
  });
});
