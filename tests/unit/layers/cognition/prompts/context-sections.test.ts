/**
 * Tests for context-sections.ts
 *
 * Validates: buildAvailableSkillsSection() renders name + description only,
 * no trust badges regardless of trust state, lastUsed preserved, empty state
 */

import { describe, it, expect, vi } from 'vitest';
import { buildAvailableSkillsSection } from '../../../../../src/layers/cognition/prompts/context-sections.js';
import type { LoopContext } from '../../../../../src/layers/cognition/agentic-loop-types.js';

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

  it('renders skill as name: description with no trust badge', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'web-scraper', description: 'Email skill', status: 'approved', hasPolicy: true },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).not.toBeNull();
    expect(result).toContain('<available_skills>');
    expect(result).toContain('- web-scraper: Email skill');
    expect(result).toContain('Invoke via core.act with skill parameter');
    // No trust badges
    expect(result).not.toContain('[approved]');
    expect(result).not.toContain('[pending_review]');
    expect(result).not.toContain('[needs_reapproval]');
  });

  it('renders pending_review skill without badge or hint', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'new-skill', description: 'New skill', status: 'pending_review', hasPolicy: true },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).toContain('- new-skill: New skill');
    expect(result).not.toContain('[pending_review]');
    expect(result).not.toContain('ask user to review');
  });

  it('renders needs_reapproval skill without badge or hint', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'outdated-skill', description: 'Old skill', status: 'needs_reapproval', hasPolicy: true },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).toContain('- outdated-skill: Old skill');
    expect(result).not.toContain('[needs_reapproval]');
    expect(result).not.toContain('content changed');
    expect(result).not.toContain('needs onboarding');
  });

  it('renders needs_reapproval without policy — no badge, no hint', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'weather', description: 'Weather skill', status: 'needs_reapproval', hasPolicy: false },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).toContain('- weather: Weather skill');
    expect(result).not.toContain('[needs_reapproval]');
    expect(result).not.toContain('needs onboarding');
  });

  it('renders mixed trust states uniformly — no badges anywhere', () => {
    const context = createMockContext({
      availableSkills: [
        { name: 'web-scraper', description: 'Email skill', status: 'approved', hasPolicy: true },
        { name: 'weather', description: 'Weather skill', status: 'needs_reapproval', hasPolicy: false },
        { name: 'new-skill', description: 'New skill', status: 'pending_review', hasPolicy: true },
      ],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).toContain('- web-scraper: Email skill');
    expect(result).toContain('- weather: Weather skill');
    expect(result).toContain('- new-skill: New skill');
    // No badges of any kind
    expect(result).not.toContain('[approved]');
    expect(result).not.toContain('[pending_review]');
    expect(result).not.toContain('[needs_reapproval]');
  });

  it('includes XML tags', () => {
    const context = createMockContext({
      availableSkills: [{ name: 'test', description: 'Test', status: 'approved', hasPolicy: true }],
    });
    const result = buildAvailableSkillsSection(context);

    expect(result).toContain('<available_skills>');
    expect(result?.endsWith('</available_skills>')).toBe(true);
  });

  describe('lastUsed display', () => {
    it('shows lastUsed time when valid timestamp provided', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T12:00:00Z'));

      const context = createMockContext({
        availableSkills: [
          {
            name: 'recent-skill',
            description: 'Recently used skill',
            status: 'approved',
            hasPolicy: true,
            lastUsed: '2026-02-10T10:00:00Z', // 2 hours ago
          },
        ],
      });
      const result = buildAvailableSkillsSection(context);

      expect(result).toContain('(used 2 hr ago)');

      vi.useRealTimers();
    });

    it('shows no lastUsed when timestamp is absent', () => {
      const context = createMockContext({
        availableSkills: [
          {
            name: 'unused-skill',
            description: 'Never used skill',
            status: 'approved',
            hasPolicy: true,
          },
        ],
      });
      const result = buildAvailableSkillsSection(context);

      expect(result).toContain('- unused-skill: Never used skill');
      expect(result).not.toContain('(used');
    });

    it('guards against invalid lastUsed timestamp', () => {
      const context = createMockContext({
        availableSkills: [
          {
            name: 'invalid-skill',
            description: 'Invalid timestamp skill',
            status: 'approved',
            hasPolicy: true,
            lastUsed: 'not-a-date',
          },
        ],
      });
      const result = buildAvailableSkillsSection(context);

      expect(result).toContain('- invalid-skill: Invalid timestamp skill');
      expect(result).not.toContain('(used');
    });

    it('handles future timestamps gracefully', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-02-10T12:00:00Z'));

      const context = createMockContext({
        availableSkills: [
          {
            name: 'future-skill',
            description: 'Future timestamp skill',
            status: 'approved',
            hasPolicy: true,
            lastUsed: '2026-02-10T14:00:00Z', // 2 hours in future (negative age)
          },
        ],
      });
      const result = buildAvailableSkillsSection(context);

      // Negative age should not display (guard prevents it)
      expect(result).not.toContain('(used');

      vi.useRealTimers();
    });
  });
});
