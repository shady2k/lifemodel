/**
 * Core Remember Tool
 *
 * Unified tool for remembering facts about the user or any subject.
 * Features:
 * - Minimal 3-field schema (subject, attribute, value)
 * - Provenance parsing from natural language in value
 * - Smart routing: subject="user" → UserModel + Vector, else → Vector only
 * - Field policy enforcement for high-stakes user fields
 */

import { getFieldPolicy, type EvidenceSource } from '../../../../types/cognition.js';
import type { Tool } from '../types.js';

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
  evidence?: string | undefined;
  isUserFact?: boolean | undefined;
}

/**
 * Create the core.remember tool.
 */
export function createRememberTool(): Tool {
  return {
    name: 'core.remember',
    description:
      'Remember a fact. For important facts, include provenance: "value (user said)" or "(inferred)"',
    tags: ['memory', 'facts', 'user-model'],
    hasSideEffects: true,
    parameters: [
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
        description: 'WHAT: birthday, preference, relationship, etc.',
      },
      {
        name: 'value',
        type: 'string',
        required: true,
        description:
          'The value. Add provenance when important: "(user said)", "(explicitly stated)", "(inferred)"',
      },
    ],
    execute: (args): Promise<RememberResult> => {
      const subject = args['subject'] as string;
      const attribute = args['attribute'] as string;
      const rawValue = args['value'] as string;

      // Validate required fields
      if (!subject || !attribute || !rawValue) {
        return Promise.resolve({
          success: false,
          error: 'Missing required fields: subject, attribute, value',
        });
      }

      // Normalize subject: "user", "me", "my", "self", "recipient" → "user"
      const normalizedSubject = normalizeSubject(subject);

      // Parse provenance from value
      const provenance = parseProvenance(rawValue);

      // Check field policy for user facts
      const isUserFact = normalizedSubject === 'user';
      if (isUserFact) {
        const policy = getFieldPolicy(`user.${attribute}`);
        const minConfidence = policy.minConfidence;

        if (provenance.confidence < minConfidence) {
          return Promise.resolve({
            success: false,
            error: `user.${attribute} requires confidence >= ${String(minConfidence)}. Add provenance like "(user said)" for higher confidence.`,
          });
        }

        // Check required source if policy specifies it
        if (policy.requireSource && !policy.requireSource.includes(provenance.source)) {
          return Promise.resolve({
            success: false,
            error: `user.${attribute} requires source from: ${policy.requireSource.join(', ')}. Got: ${provenance.source}. Use "(user said)" for user_quote.`,
          });
        }
      }

      return Promise.resolve({
        success: true,
        action: 'remember',
        subject: normalizedSubject,
        attribute,
        value: provenance.cleanValue,
        confidence: provenance.confidence,
        source: provenance.source,
        evidence: provenance.evidence,
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

/**
 * Parse provenance markers from natural language value.
 * Extracts confidence level and evidence source from inline markers.
 *
 * Examples:
 * - "November 9 (user said)" → user_quote, 0.98
 * - "November 9 (explicitly stated)" → user_explicit, 0.95
 * - "likes coffee (mentioned)" → user_implicit, 0.85
 * - "prefers mornings (inferred)" → inferred, 0.6
 * - "dark mode" (no marker) → inferred, 0.8
 */
function parseProvenance(value: string): {
  cleanValue: string;
  source: EvidenceSource;
  confidence: number;
  evidence?: string;
} {
  const lower = value.toLowerCase();

  // Direct quote (highest confidence) - maps to user_quote
  if (lower.includes('(user said)') || lower.includes('(said:')) {
    const clean = value
      .replace(/\s*\(user said\)\s*/gi, '')
      .replace(/\s*\(said:[^)]+\)\s*/gi, '')
      .trim();
    return { cleanValue: clean, source: 'user_quote', confidence: 0.98, evidence: value };
  }

  // User explicitly stated - maps to user_explicit
  if (lower.includes('(user explicitly stated)') || lower.includes('(explicitly stated)')) {
    const clean = value.replace(/\s*\((user )?explicitly stated\)\s*/gi, '').trim();
    return { cleanValue: clean, source: 'user_explicit', confidence: 0.95, evidence: value };
  }

  // User mentioned - maps to user_implicit
  if (lower.includes('(user mentioned)') || lower.includes('(mentioned)')) {
    const clean = value.replace(/\s*\((user )?mentioned\)\s*/gi, '').trim();
    return { cleanValue: clean, source: 'user_implicit', confidence: 0.85, evidence: value };
  }

  // Observed/noticed - maps to inferred with higher confidence
  if (lower.includes('(observed)') || lower.includes('(i noticed)')) {
    const clean = value.replace(/\s*\((observed|i noticed)\)\s*/gi, '').trim();
    return { cleanValue: clean, source: 'inferred', confidence: 0.7 };
  }

  // Inferred (lower confidence)
  if (lower.includes('(inferred)') || lower.includes('(from context)')) {
    const clean = value.replace(/\s*\((inferred|from context)\)\s*/gi, '').trim();
    return { cleanValue: clean, source: 'inferred', confidence: 0.6 };
  }

  // Default: no provenance marker - LOW confidence (safe default)
  // LLM should add markers for higher confidence facts
  return { cleanValue: value, source: 'inferred', confidence: 0.5 };
}
