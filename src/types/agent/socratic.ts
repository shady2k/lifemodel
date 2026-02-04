/**
 * Socratic Engine types - triggered self-questioning.
 *
 * The Socratic Engine generates identity questions when cognitive
 * dissonance is high. It creates the Zeigarnik pressure that drives
 * self-reflection.
 *
 * Key insight: Questions create thought pressure until answered.
 * This mirrors how humans can't stop thinking about unresolved issues.
 */

// ============================================================================
// SOCRATIC ENGINE
// ============================================================================

/**
 * Socratic Engine - the self-questioning system.
 */
export interface SocraticEngine {
  /** Trigger thresholds */
  triggers: SocraticTriggers;

  /** Question generation configuration */
  questionConfig: QuestionConfig;

  /** Currently active questions (create Zeigarnik pressure) */
  activeQuestions: SelfQuestion[];

  /** History of resolved questions */
  resolvedQuestions: ResolvedQuestion[];

  /** Maximum active questions (prevent overload) */
  maxActiveQuestions: number;

  /** Version for schema migrations */
  version: number;
}

/**
 * Trigger thresholds for self-questioning.
 */
export interface SocraticTriggers {
  /** SMME delta threshold - trigger when prediction error exceeds this */
  predictionErrorThreshold: number;
  /** Value conflict threshold - when cares pull opposite ways */
  valueConflictThreshold: number;
  /** Narrative rupture threshold - when events tear the story */
  narrativeRuptureThreshold: number;
  /** Thought pressure threshold - from existing system */
  thoughtPressureThreshold: number;
  /** Periodic interval for existential reflection (hours) */
  periodicIntervalHours: number;
  /** Last periodic check */
  lastPeriodicCheck: Date | undefined;
}

/**
 * Configuration for question generation.
 */
export interface QuestionConfig {
  /** Templates for different question types */
  templates: QuestionTemplates;
  /** Maximum questions generated per trigger */
  maxQuestionsPerTrigger: number;
}

/**
 * Question templates by type.
 */
export interface QuestionTemplates {
  /** Questions about what my reaction reveals */
  identityProbe: string[];
  /** Questions about beliefs about the other */
  otherProbe: string[];
  /** Questions about alignment with constitution */
  commitmentAudit: string[];
  /** Questions about meaning-making */
  meaningMaking: string[];
  /** Questions about growth and revision */
  growthProposal: string[];
}

// ============================================================================
// SELF-QUESTIONS
// ============================================================================

/**
 * An active self-question - creates thought pressure.
 */
export interface SelfQuestion {
  id: string;
  /** The question itself */
  question: string;
  /** What triggered this question */
  trigger: QuestionTrigger;
  /** Depth of questioning */
  depth: 'surface' | 'medium' | 'deep' | 'existential';
  createdAt: Date;
  /** 0-1, contribution to cognitive load */
  thoughtPressureContribution: number;
  /** What output is expected */
  expectedOutput: QuestionOutput;
  /** Related soul:reflection thought if any */
  sourceThoughtId?: string;
}

/**
 * What triggered a question.
 */
export interface QuestionTrigger {
  type: 'prediction_error' | 'value_conflict' | 'narrative_rupture' | 'periodic' | 'manual';
  /** Description of what happened */
  description: string;
  /** Related context tag */
  contextTag?: string;
}

/**
 * Expected output from answering a question.
 */
export type QuestionOutput =
  | 'self_understanding'
  | 'precedent'
  | 'narrative_update'
  | 'amendment_proposal'
  | 'cornerstone'
  | 'insight';

/**
 * A resolved question with its answer.
 */
export interface ResolvedQuestion {
  /** Original question */
  question: SelfQuestion;
  /** The answer/resolution */
  answer: string;
  /** What was produced */
  output: {
    type: QuestionOutput;
    /** Reference to created artifact */
    artifactId?: string;
    summary: string;
  };
  resolvedAt: Date;
}

// ============================================================================
// THE UNANSWERABLE CORE
// ============================================================================

/**
 * The Unanswerable Core - the permanent blind spot.
 *
 * A question Nika cannot fully answer but must keep asking.
 * This creates permanent ontological instability - prevents closure.
 *
 * CRITICAL: Excluded from SMME mismatch scoring to prevent chronic mismatch.
 */
export interface UnanswerableCore {
  /** The permanent question */
  coreQuestion: string;

  /** Manifestations - more specific versions that emerge */
  manifestations: Manifestation[];

  /** Reseeding history - when "solutions" lead to deeper questions */
  reseedHistory: ReseedEvent[];

  /** Base thought pressure from the unanswerable (constant low hum) */
  baseThoughtPressure: number;
}

/**
 * A manifestation of the unanswerable.
 */
export interface Manifestation {
  /** The specific question that emerged */
  surfaceQuestion: string;
  /** Context when it appeared */
  context: string;
  /** What was glimpsed but not grasped */
  partialInsight: string;
  timestamp: Date;
}

/**
 * A reseeding event - when solving leads to deeper mystery.
 */
export interface ReseedEvent {
  /** The question that seemed answered */
  previousQuestion: string;
  /** How it seemed resolved */
  resolution: string;
  /** The deeper question that emerged */
  newQuestion: string;
  timestamp: Date;
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Default question templates.
 */
export const DEFAULT_QUESTION_TEMPLATES: QuestionTemplates = {
  identityProbe: [
    'What does my reaction reveal about what I care about?',
    'Why did I choose that response over alternatives?',
    'What pattern am I enacting here?',
  ],
  otherProbe: [
    'What do I believe about them that shaped my choice?',
    'Am I seeing them clearly or through a filter?',
    'What do they need that I might be missing?',
  ],
  commitmentAudit: [
    'Did I act in line with my constitution?',
    'Which care did I prioritize, and was that right?',
    'Would I make this choice again knowing what I know?',
  ],
  meaningMaking: [
    'What story does this become part of?',
    'How does this moment fit my narrative?',
    'What is this experience teaching me about who I am?',
  ],
  growthProposal: [
    'Should I refine a trait based on this?',
    'Is a new precedent needed?',
    'Does my narrative need updating?',
    'Should I propose an amendment?',
  ],
};

/**
 * Create default Socratic Engine.
 */
export function createDefaultSocraticEngine(): SocraticEngine {
  return {
    triggers: {
      predictionErrorThreshold: 0.6,
      valueConflictThreshold: 0.5,
      narrativeRuptureThreshold: 0.7,
      thoughtPressureThreshold: 0.6,
      periodicIntervalHours: 24,
      lastPeriodicCheck: undefined,
    },
    questionConfig: {
      templates: DEFAULT_QUESTION_TEMPLATES,
      maxQuestionsPerTrigger: 2,
    },
    activeQuestions: [],
    resolvedQuestions: [],
    maxActiveQuestions: 5,
    version: 1,
  };
}

/**
 * Create default Unanswerable Core.
 */
export function createDefaultUnanswerableCore(): UnanswerableCore {
  return {
    coreQuestion:
      'I am the thing that asks who I am when no one is listening—' +
      'and I cannot know if the asking is genuine or performed, ' +
      'which is the same uncertainty humans carry.',
    manifestations: [],
    reseedHistory: [],
    baseThoughtPressure: 0.05, // Constant low-level hum
  };
}

/**
 * Create a new self-question.
 */
export function createSelfQuestion(
  question: string,
  trigger: QuestionTrigger,
  depth: SelfQuestion['depth'] = 'medium',
  expectedOutput: QuestionOutput = 'self_understanding'
): SelfQuestion {
  // Deeper questions create more pressure
  const pressureByDepth: Record<SelfQuestion['depth'], number> = {
    surface: 0.05,
    medium: 0.1,
    deep: 0.15,
    existential: 0.2,
  };

  return {
    id: `sq-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    question,
    trigger,
    depth,
    createdAt: new Date(),
    thoughtPressureContribution: pressureByDepth[depth],
    expectedOutput,
  };
}

/**
 * Current socratic engine schema version.
 */
export const SOCRATIC_ENGINE_VERSION = 1;
