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
      name: 'subject',
      type: 'string',
      required: true,
      description: 'WHO: "user", person name, or topic',
    },
    {
      name: 'attribute',
      type: 'string',
      required: true,
      description:
        'WHAT: birthday, preference, relationship, etc. Special: interest_<topic> or urgency_<topic> for news preferences.',
    },
    {
      name: 'value',
      type: 'string',
      required: true,
      description:
        'The value. For numeric properties: use delta like "+0.2" or "-0.1" to adjust (clamped to 0-1).',
    },
    {
      name: 'source',
      type: 'string',
      enum: EVIDENCE_SOURCES,
      required: true,
      description:
        'How we learned this: user_quote (direct quote), user_explicit (clearly stated), user_implicit (implied), inferred (deduced)',
    },
    {
      name: 'confidence',
      type: 'number',
      required: false,
      description: 'Confidence level 0-1. If omitted, uses default based on source.',
    },
  ];

  return {
    name: 'core.remember',
    description: 'Remember a fact about the user or any subject.',
    tags: ['memory', 'facts', 'user-model'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args): Promise<RememberResult> => {
      const subject = args['subject'] as string | undefined;
      const attribute = args['attribute'] as string | undefined;
      const value = args['value'] as string | undefined;
      const sourceArg = args['source'] as string | undefined;
      // Handle both undefined and null (strict mode sends null for optional fields)
      const confidenceArg = args['confidence'] as number | null | undefined;

      // Validate required fields
      if (!subject || !attribute || !value || !sourceArg) {
        return Promise.resolve({
          success: false,
          error: 'Missing required fields: subject, attribute, value, source',
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
