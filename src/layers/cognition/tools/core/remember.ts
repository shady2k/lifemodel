/**
 * Core Remember Tool
 *
 * Unified tool for remembering facts about the user or any subject.
 * Features:
 * - Explicit schema with source and confidence fields
 * - Smart routing: subject="user" → UserModel + Vector, else → Vector only
 * - Field policy enforcement for high-stakes user fields
 */

import { getFieldPolicy, type EvidenceSource } from '../../../../types/cognition.js';
import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Valid evidence sources for the tool schema.
 */
const EVIDENCE_SOURCES = ['user_quote', 'user_explicit', 'user_implicit', 'inferred'] as const;

/**
 * Default confidence levels by source type.
 */
const SOURCE_DEFAULT_CONFIDENCE: Record<string, number> = {
  user_quote: 0.98,
  user_explicit: 0.95,
  user_implicit: 0.85,
  inferred: 0.6,
};

/**
 * Result from core.remember tool execution.
 */
export interface RememberResult {
  success: boolean;
  error?: string | undefined;
  action?: 'remember' | undefined;
  subject?: string | undefined;
  attribute?: string | undefined;
  value?: string | undefined;
  confidence?: number | undefined;
  source?: EvidenceSource | undefined;
  isUserFact?: boolean | undefined;
}

/**
 * Create the core.remember tool.
 */
export function createRememberTool(): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'attribute',
      type: 'string',
      required: true,
      description: 'What to remember (birthday, preference, work_style, habit, etc.)',
    },
    {
      name: 'value',
      type: 'string',
      required: true,
      description: 'The value or fact',
    },
    {
      name: 'subject',
      type: 'string',
      required: false,
      description: 'Who/what this is about (default: user). Set for non-user subjects.',
    },
    {
      name: 'source',
      type: 'string',
      enum: EVIDENCE_SOURCES,
      required: false,
      description:
        'Evidence type (default: user_implicit). Set user_explicit/user_quote for high-stakes facts like name, birthday.',
    },
    { name: 'confidence', type: 'number', required: false, description: '0-1 (auto from source)' },
  ];

  return {
    name: 'core.remember',
    maxCallsPerTurn: 3,
    description:
      'Remember a stable user trait or fact. NOT for data managed by plugin tools (calories, weight, news). Minimal: attribute + value (defaults: subject=user, source=user_implicit). For non-user subjects or explicit statements (name, birthday), specify subject/source.',
    tags: ['memory', 'facts', 'user-model'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args): Promise<RememberResult> => {
      // Apply defaults for optional fields
      const subjectRaw = args['subject'] as string | null | undefined;
      const subject = subjectRaw ?? 'user';
      const attribute = args['attribute'] as string | undefined;
      const value = args['value'] as string | undefined;
      const sourceRaw = args['source'] as string | null | undefined;
      const sourceArg = sourceRaw ?? 'user_implicit';
      // Handle both undefined and null (strict mode sends null for optional fields)
      const confidenceArg = args['confidence'] as number | null | undefined;

      // Validate required fields (only attribute and value now)
      if (!attribute || !value) {
        return Promise.resolve({
          success: false,
          error: 'Missing required fields: attribute, value',
        });
      }

      // Validate source enum
      if (!EVIDENCE_SOURCES.includes(sourceArg as (typeof EVIDENCE_SOURCES)[number])) {
        return Promise.resolve({
          success: false,
          error: `Invalid source: ${sourceArg}. Must be one of: ${EVIDENCE_SOURCES.join(', ')}`,
        });
      }

      // Now we know source is valid
      const source = sourceArg as EvidenceSource;

      // Normalize subject: "user", "me", "my", "self", "recipient" → "user"
      const normalizedSubject = normalizeSubject(subject);

      // Use provided confidence or default based on source
      const confidence = confidenceArg ?? SOURCE_DEFAULT_CONFIDENCE[source] ?? 0.5;

      // Validate confidence range
      if (confidence < 0 || confidence > 1) {
        return Promise.resolve({
          success: false,
          error: 'Confidence must be between 0 and 1',
        });
      }

      // Check field policy for user facts
      const isUserFact = normalizedSubject === 'user';
      if (isUserFact) {
        const policy = getFieldPolicy(`user.${attribute}`);

        if (confidence < policy.minConfidence) {
          return Promise.resolve({
            success: false,
            error: `user.${attribute} requires confidence >= ${String(policy.minConfidence)}. Got: ${String(confidence)}`,
          });
        }

        // Check required source if policy specifies it
        if (policy.requireSource && !policy.requireSource.includes(source)) {
          return Promise.resolve({
            success: false,
            error: `user.${attribute} requires source from: ${policy.requireSource.join(', ')}. Got: ${source}`,
          });
        }
      }

      return Promise.resolve({
        success: true,
        action: 'remember',
        subject: normalizedSubject,
        attribute,
        value,
        confidence,
        source,
        isUserFact,
      });
    },
  };
}

/**
 * Normalize subject to canonical form.
 * Maps user-referencing terms to "user" for consistent routing.
 */
function normalizeSubject(subject: string): string {
  const lower = subject.toLowerCase().trim();
  const userAliases = ['user', 'me', 'my', 'self', 'recipient', 'i'];
  if (userAliases.includes(lower)) {
    return 'user';
  }
  return subject.trim();
}
