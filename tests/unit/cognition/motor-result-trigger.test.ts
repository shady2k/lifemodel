/**
 * Unit tests for buildMotorResultSection trigger prompt builder.
 */

import { describe, it, expect } from 'vitest';
import { buildMotorResultSection } from '../../../src/layers/cognition/prompts/trigger-sections.js';
import type { MotorResultData } from '../../../src/types/signal.js';

describe('buildMotorResultSection', () => {
  describe('completed status', () => {
    it('generates completed trigger with summary and stats', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-123',
        status: 'completed',
        attemptIndex: 0,
        result: {
          ok: true,
          summary: 'Successfully fetched and parsed API data',
          stats: { iterations: 5, durationMs: 12000, energyCost: 0.1, errors: 0 },
        },
      };

      const section = buildMotorResultSection(data);

      expect(section).toContain('<trigger type="motor_result">');
      expect(section).toContain('run-123 completed');
      expect(section).toContain('Successfully fetched');
      expect(section).toContain('5 iterations');
      expect(section).toContain('12.0s');
      expect(section).toContain('Report the result');
    });

    it('includes two-layer review instructions for skill creation', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-456',
        status: 'completed',
        attemptIndex: 0,
        result: {
          ok: true,
          summary: 'Created skill',
          stats: { iterations: 3, durationMs: 5000, energyCost: 0.05, errors: 0 },
          installedSkills: {
            created: ['agentmail'],
            updated: [],
          },
        },
      };

      const section = buildMotorResultSection(data);

      // Should include deterministic review action
      expect(section).toContain('core.skill(action:"review"');
      // Should include Motor review dispatch (not read action)
      expect(section).toContain('skill_review:true');
      // Should instruct to say "analyzing"
      expect(section).toContain('Analyzing skill files');
    });

    it('includes updated bash warning wording', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-789',
        status: 'completed',
        attemptIndex: 0,
        result: {
          ok: true,
          summary: 'Created skill with bash',
          stats: { iterations: 3, durationMs: 5000, energyCost: 0.05, errors: 0 },
          installedSkills: {
            created: ['test-skill'],
            updated: [],
          },
        },
      };

      const section = buildMotorResultSection(data);

      // Should have the new observability-focused wording
      expect(section).toContain('not instrumented in run evidence');
      expect(section).toContain('enforced by the container firewall');
    });

    it('does not include review instructions for non-skill completions', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-no-skills',
        status: 'completed',
        attemptIndex: 0,
        result: {
          ok: true,
          summary: 'Fetched weather data',
          stats: { iterations: 2, durationMs: 3000, energyCost: 0.02, errors: 0 },
        },
      };

      const section = buildMotorResultSection(data);

      expect(section).not.toContain('SECURITY REVIEW');
      expect(section).not.toContain('core.skill(action:"review"');
      expect(section).not.toContain('core.skill(action:"read"');
      expect(section).toContain('Report the result');
    });

    it('includes untrusted content safety note', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-safety',
        status: 'completed',
        attemptIndex: 0,
        result: {
          ok: true,
          summary: 'Created skill',
          stats: { iterations: 1, durationMs: 1000, energyCost: 0.01, errors: 0 },
          installedSkills: {
            created: ['untrusted-skill'],
            updated: [],
          },
        },
      };

      const section = buildMotorResultSection(data);

      // Should note Motor Cortex is untrusted
      expect(section).toContain('Motor Cortex is untrusted');
      // Should include Motor review dispatch for file analysis
      expect(section).toContain('skill_review:true');
    });
  });

  describe('failed status', () => {
    it('generates failed trigger with structured failure and retry instructions', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-456',
        status: 'failed',
        attemptIndex: 0,
        failure: {
          category: 'tool_failure',
          lastErrorCode: 'timeout',
          retryable: true,
          suggestedAction: 'retry_with_guidance',
          lastToolResults: [
            { tool: 'shell', ok: false, errorCode: 'timeout', output: 'Connection timed out after 30s' },
          ],
          hint: 'The API endpoint appears to be down. Try the backup URL.',
        },
      };

      const section = buildMotorResultSection(data);

      expect(section).toContain('<trigger type="motor_result_failed">');
      expect(section).toContain('run-456 attempt 0 failed');
      expect(section).toContain('Category: tool_failure');
      expect(section).toContain('Retryable: true');
      expect(section).toContain('Last error: timeout');
      expect(section).toContain('shell: FAIL (timeout)');
      expect(section).toContain('Analysis: The API endpoint appears to be down');
      expect(section).toContain('core.task(action:"retry"');
      expect(section).toContain('Do NOT create a new core.act');
    });

    it('generates non-retryable failure without retry instructions', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-789',
        status: 'failed',
        attemptIndex: 2,
        failure: {
          category: 'budget_exhausted',
          retryable: false,
          suggestedAction: 'stop',
          lastToolResults: [],
        },
      };

      const section = buildMotorResultSection(data);

      expect(section).toContain('Retryable: false');
      expect(section).toContain('budget_exhausted');
    });

    it('handles legacy error format without failure', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-legacy',
        status: 'failed',
        error: { message: 'Something went wrong' },
      };

      const section = buildMotorResultSection(data);

      expect(section).toContain('motor_result_failed');
      expect(section).toContain('Something went wrong');
      expect(section).toContain('Report the failure');
    });
  });

  describe('awaiting_input status', () => {
    it('generates awaiting input trigger with question', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-input',
        status: 'awaiting_input',
        question: 'What format should the output be in?',
      };

      const section = buildMotorResultSection(data);

      expect(section).toContain('<trigger type="motor_awaiting_input">');
      expect(section).toContain('What format should the output be in?');
      expect(section).toContain('core.task(action:"respond"');
      expect(section).toContain('run-input');
    });
  });

  describe('awaiting_approval status', () => {
    it('generates awaiting approval trigger with action', () => {
      const data: MotorResultData = {
        kind: 'motor_result',
        runId: 'run-approval',
        status: 'awaiting_approval',
        approval: {
          action: 'Send POST request to https://api.example.com/data',
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        },
      };

      const section = buildMotorResultSection(data);

      expect(section).toContain('<trigger type="motor_awaiting_approval">');
      expect(section).toContain('Send POST request to https://api.example.com/data');
      expect(section).toContain('core.task(action:"approve"');
      expect(section).toContain('run-approval');
    });
  });
});
