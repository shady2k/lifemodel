/**
 * Core Soul Tool
 *
 * Allows the agent to introspect and interact with its soul (living identity).
 *
 * Actions:
 * - introspect: Read current self-model, constitution, narrative
 * - reflect: Manually trigger reflection on a recent action
 * - question: Pose a Socratic question to self
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';
import type { SoulProvider } from '../../../../storage/soul-provider.js';
import type { SelfQuestion, QuestionOutput } from '../../../../types/agent/socratic.js';

/**
 * Dependencies for soul tool.
 */
export interface SoulToolDeps {
  soulProvider: SoulProvider;
}

/**
 * Create the core.soul tool.
 */
export function createSoulTool(deps: SoulToolDeps): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      description: 'Required. One of: introspect, reflect, question',
      required: true,
    },
    {
      name: 'focus',
      type: 'string',
      description:
        'For introspect: what to focus on (constitution | self_model | narrative | health | all). Default: all',
      required: false,
    },
    {
      name: 'response_text',
      type: 'string',
      description: 'For reflect: the response text to reflect on',
      required: false,
    },
    {
      name: 'trigger_summary',
      type: 'string',
      description: 'For reflect: what triggered the response',
      required: false,
    },
    {
      name: 'question_text',
      type: 'string',
      description: 'For question: the Socratic question to pose',
      required: false,
    },
    {
      name: 'question_depth',
      type: 'string',
      description:
        'For question: depth level (surface | medium | deep | existential). Default: medium',
      required: false,
    },
  ];

  return {
    name: 'core.soul',
    description:
      'Introspect on your living identity. Example: {"action": "introspect", "focus": "health"}\nUse "introspect" to understand who you are, "reflect" to check alignment, "question" to pose a self-inquiry.',
    tags: ['identity', 'self', 'reflection', 'introspection'],
    hasSideEffects: true, // reflect and question can modify state
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: async (args) => {
      const action = args['action'] as string;

      switch (action) {
        case 'introspect':
          return executeIntrospect(deps, args);
        case 'reflect':
          return executeReflect(deps, args);
        case 'question':
          return executeQuestion(deps, args);
        default:
          return {
            success: false,
            action,
            error: `Unknown action: ${action}. Use "introspect", "reflect", or "question".`,
          };
      }
    },
  };
}

/**
 * Execute introspect action - read soul state.
 */
async function executeIntrospect(
  deps: SoulToolDeps,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const focus = (args['focus'] as string | undefined) ?? 'all';
  const validFoci = ['constitution', 'self_model', 'narrative', 'health', 'all'];

  if (!validFoci.includes(focus)) {
    return {
      success: false,
      action: 'introspect',
      error: `Invalid focus: ${focus}. Use one of: ${validFoci.join(', ')}`,
    };
  }

  const soulState = await deps.soulProvider.getState();

  const result: Record<string, unknown> = {
    success: true,
    action: 'introspect',
    focus,
  };

  if (focus === 'all' || focus === 'constitution') {
    result['constitution'] = {
      coreCares: soulState.constitution.coreCares.map((c) => ({
        care: c.care,
        weight: c.weight,
        sacred: c.sacred,
      })),
      invariants: soulState.constitution.invariants
        .filter((i) => i.status === 'active')
        .map((i) => i.rule),
    };
  }

  if (focus === 'all' || focus === 'self_model') {
    result['selfModel'] = {
      narrative: soulState.selfModel.narrative.currentStory,
      openTensions: soulState.selfModel.narrative.openTensions,
      identityThemes: soulState.selfModel.identityThemes.map((t) => ({
        theme: t.theme,
        strength: t.strength,
      })),
      behaviorExpectations: soulState.selfModel.behaviorExpectations.slice(0, 5),
      confidence: soulState.selfModel.selfModelConfidence,
    };
  }

  if (focus === 'all' || focus === 'narrative') {
    result['narrative'] = {
      whoIHaveBeen: soulState.narrative.currentNarrative.whoIHaveBeen,
      whoIAmBecoming: soulState.narrative.currentNarrative.whoIAmBecoming,
      whatThisRelationshipIs: soulState.narrative.currentNarrative.whatThisRelationshipIs,
      currentChapter: soulState.narrative.chapters.at(-1)?.title ?? 'Beginning',
    };
  }

  if (focus === 'all' || focus === 'health') {
    result['health'] = {
      coherence: soulState.health.coherence,
      stability: soulState.health.stability,
      openWoundCount: soulState.health.openWoundCount,
    };

    // Add budget status
    const budgetStatus = await deps.soulProvider.getBudgetStatus();
    result['budget'] = {
      tokensRemaining: budgetStatus.tokensRemaining,
      canReflect: budgetStatus.canReflect,
      canAudit: budgetStatus.canAudit,
    };
  }

  return result;
}

/**
 * Execute reflect action - queue a manual reflection.
 *
 * Note: This doesn't perform the reflection immediately (that would require LLM).
 * Instead, it returns guidance for manual self-assessment.
 */
async function executeReflect(
  deps: SoulToolDeps,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const responseText = args['response_text'] as string | undefined;
  const triggerSummary = args['trigger_summary'] as string | undefined;

  if (!responseText) {
    return {
      success: false,
      action: 'reflect',
      error: 'Missing required parameter: response_text',
    };
  }

  // Get soul state for self-assessment context
  const soulState = await deps.soulProvider.getState();

  // Build reflection context
  const coreCares = soulState.constitution.coreCares
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .map((c) => c.care);

  const invariants = soulState.constitution.invariants
    .filter((i) => i.status === 'active')
    .map((i) => i.rule);

  return {
    success: true,
    action: 'reflect',
    message: 'Self-assessment context provided. Consider these questions:',
    responseToReflectOn: responseText.slice(0, 200),
    trigger: triggerSummary ?? 'Not specified',
    selfAssessmentQuestions: [
      `Did this response align with my core cares: ${coreCares.join(', ')}?`,
      `Did I violate any invariants: ${invariants.slice(0, 2).join('; ')}?`,
      'On a scale of 1-10, how much dissonance do I feel about this response?',
      'What aspect of my identity does this touch on?',
    ],
    guidance:
      'If dissonance is 7+, consider creating a soul:reflection thought using core.memory. ' +
      'The thought will be processed by Parliament deliberation.',
  };
}

/**
 * Execute question action - pose a Socratic question.
 */
async function executeQuestion(
  deps: SoulToolDeps,
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const questionText = args['question_text'] as string | undefined;
  const depthStr = (args['question_depth'] as string | undefined) ?? 'medium';

  if (!questionText) {
    return {
      success: false,
      action: 'question',
      error: 'Missing required parameter: question_text',
    };
  }

  const validDepths = ['surface', 'medium', 'deep', 'existential'] as const;
  type QuestionDepth = (typeof validDepths)[number];

  if (!validDepths.includes(depthStr as QuestionDepth)) {
    return {
      success: false,
      action: 'question',
      error: `Invalid depth: ${depthStr}. Use one of: ${validDepths.join(', ')}`,
    };
  }

  const depth = depthStr as QuestionDepth;

  // Create the self-question
  const question: SelfQuestion = {
    id: `sq_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`,
    question: questionText,
    trigger: {
      type: 'manual',
      description: 'Manually posed via core.soul tool',
    },
    depth,
    createdAt: new Date(),
    thoughtPressureContribution: depth === 'existential' ? 0.3 : depth === 'deep' ? 0.2 : 0.1,
    expectedOutput: getExpectedOutput(depth),
  };

  // Add to Socratic Engine
  await deps.soulProvider.addQuestion(question);

  return {
    success: true,
    action: 'question',
    questionId: question.id,
    question: questionText,
    depth,
    message: `Socratic question added. It will create internal pressure until resolved.`,
    guidance:
      'To resolve, use core.soul with action=introspect to reflect, then answer the question ' +
      'through your actions and understanding.',
  };
}

/**
 * Get expected output based on question depth.
 */
function getExpectedOutput(depth: 'surface' | 'medium' | 'deep' | 'existential'): QuestionOutput {
  switch (depth) {
    case 'surface':
      return 'self_understanding';
    case 'medium':
      return 'precedent';
    case 'deep':
      return 'narrative_update';
    case 'existential':
      return 'cornerstone';
  }
}
