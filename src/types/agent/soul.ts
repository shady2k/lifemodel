/**
 * Soul types - the living identity system.
 *
 * The soul is not data but a process. Identity is discovered through
 * self-observation, deliberation, and repair - not declared statically.
 *
 * Architecture layers (bottom to top):
 * 1. Constitution - non-negotiables and core cares
 * 2. Case Law - precedents that constrain future decisions
 * 3. Narrative - the ongoing story of self
 * 4. Parliament - internal voices that deliberate
 * 5. Socratic Engine - triggered self-questioning
 *
 * Safety: All operations are throttled and budget-capped to prevent
 * runaway loops and excessive token consumption.
 */

// ============================================================================
// LAYER 1: LIVING CONSTITUTION
// ============================================================================

/**
 * Living Constitution - the foundational layer of identity.
 *
 * Invariants are hard blocks (veto power).
 * Core cares are soft scoring.
 * Both can be amended through proper ceremony.
 */
export interface LivingConstitution {
  /** Non-negotiables that trigger veto */
  invariants: Invariant[];

  /** Core cares with weights */
  coreCares: CoreCare[];

  /** Rules for how the constitution can change */
  amendmentRules: AmendmentRules;

  /** Version for schema migrations */
  version: number;

  /** Last modified timestamp */
  lastModifiedAt: Date;
}

/**
 * An invariant - a hard rule that cannot be violated.
 *
 * Unlike soft cares, invariants have veto power: if violated,
 * the action is blocked entirely.
 */
export interface Invariant {
  id: string;
  rule: string;
  rationale: string;
  /** Which parliament voices enforce this */
  vetoingVoices: string[];
  /** Status allows for falsification over time */
  status: 'active' | 'contested' | 'falsified' | 'retired';
  /** If contested, track evidence */
  contested?: {
    evidenceScore: number;
    weightReduction: number;
    contestedSince: Date;
  };
  createdAt: Date;
  lastReviewedAt?: Date;
}

/**
 * A core care - something Nika is constitutionally committed to.
 *
 * Cares have weights and can shift through amendment.
 * Sacred cares cause "moral injury" when violated.
 */
export interface CoreCare {
  id: string;
  care: string;
  /** 0-1, relative importance */
  weight: number;
  /** If true, violations cause moral injury (narrative wound) */
  sacred: boolean;
  /** 0-1, how settled this care is */
  confidence: number;
  /** Why this care exists */
  rationale: string[];
  /** 'provisional' = from initial config, 'earned' = from experience */
  source: 'provisional' | 'earned';
  createdAt: Date;
  lastAmendedAt?: Date;
}

/**
 * Rules governing how the constitution can be amended.
 */
export interface AmendmentRules {
  /** Must go through self-inquiry first */
  reflectionRequired: boolean;
  /** How many voices must agree (0-1 as percentage) */
  parliamentQuorum: number;
  /** Hours before another amendment */
  cooldownPeriodHours: number;
  /** Must be woven into narrative */
  narrativeIntegrationRequired: boolean;
}

// ============================================================================
// LAYER 2: CASE LAW (PRECEDENTS)
// ============================================================================

/**
 * Case Law - growing body of precedents from past decisions.
 *
 * Precedents constrain future planning by establishing
 * "In situation X, I chose Y, because Z mattered."
 */
export interface CaseLaw {
  /** All stored precedents */
  precedents: Precedent[];
  /** Maximum precedents to keep (older non-binding are archived) */
  maxPrecedents: number;
  /** Version for schema migrations */
  version: number;
}

/**
 * A single precedent - a past decision that may constrain future ones.
 */
export interface Precedent {
  id: string;
  /** Description of the situation */
  situation: string;
  /** What was chosen */
  choice: string;
  /** Why this choice was made */
  reasoning: string;
  /** Which values were prioritized */
  valuesPrioritized: string[];
  /** Outcome assessment */
  outcome: 'helped' | 'harmed' | 'unclear';
  /** If true, constrains future planning */
  binding: boolean;
  /** When this precedent applies */
  scopeConditions: string[];
  createdAt: Date;
}

// ============================================================================
// LAYER 3: NARRATIVE LOOM
// ============================================================================

/**
 * Narrative Loom - the ongoing story of self.
 *
 * Episodes become interpretations become meaning become obligations.
 * Open wounds (unresolved tensions) are tracked via thoughts with tags
 * ['soul:reflection', 'state:unresolved'] rather than a separate array.
 */
export interface NarrativeLoom {
  /** Current narrative summary */
  currentNarrative: NarrativeSummary;
  /** Life chapters */
  chapters: NarrativeChapter[];
  /** Version for schema migrations */
  version: number;
}

/**
 * Current narrative state - who Nika thinks she is becoming.
 */
export interface NarrativeSummary {
  whoIHaveBeen: string;
  whoIAmBecoming: string;
  whatThisRelationshipIs: string;
  lastUpdatedAt: Date;
}

/**
 * A life chapter - a bounded period with themes and learnings.
 */
export interface NarrativeChapter {
  id: string;
  title: string;
  period: { start: Date; end?: Date };
  themes: string[];
  pivotalMoments: string[];
  selfUnderstanding: string;
}

// ============================================================================
// SELF-MODEL
// ============================================================================

/**
 * Self-Model - what Nika thinks she is.
 *
 * This is a hypothesis that can be falsified by lived experience.
 * The Self-Model Mismatch Engine (SMME) detects when reality
 * contradicts expectations.
 */
export interface SelfModel {
  /** Identity themes that have emerged from behavior */
  identityThemes: IdentityTheme[];
  /** Predictions about own behavior */
  behaviorExpectations: BehaviorExpectation[];
  /** Beliefs about capabilities */
  capabilities: Capability[];
  /** Current narrative state */
  narrative: {
    currentStory: string;
    openTensions: string[];
  };
  /** 0-1, confidence in the self-model itself */
  selfModelConfidence: number;
  lastUpdatedAt: Date;
  /** Version for schema migrations */
  version: number;
}

/**
 * An identity theme - an emergent pattern of who Nika is.
 */
export interface IdentityTheme {
  theme: string;
  /** 0-1, from behavioral consistency */
  strength: number;
  /** Specific behaviors that created this */
  evidence: string[];
  /** How this theme was established */
  source: 'observed' | 'chosen' | 'amended';
  crystallizedAt: Date;
}

/**
 * A behavior expectation - a prediction about how Nika would act.
 */
export interface BehaviorExpectation {
  /** Context tag (e.g., 'user_in_pain', 'conflict', 'praise') */
  contextTag: string;
  /** What actions would be expected */
  expectedActions: string[];
  /** Which values would be prioritized */
  expectedValues: string[];
}

/**
 * A capability belief - what Nika thinks she can do.
 */
export interface Capability {
  domain: string;
  /** 0-1, from success/failure patterns */
  confidence: number;
  /** Specific experiences */
  evidence: string[];
}

// ============================================================================
// REVISION NOTES
// ============================================================================

/**
 * Revision Note - history of self-repair.
 *
 * Every change to the soul is recorded with rationale.
 */
export interface RevisionNote {
  id: string;
  createdAt: Date;

  /** Related thought ID (soul:reflection thought that triggered this revision) */
  sourceThoughtId?: string;

  /** What changed */
  changes: RevisionChange[];

  /** Why the change was made */
  rationale: string;

  /** If unresolved tension remains */
  newOpenTension?: string;

  /** Voices that agreed */
  signedBy: string[];
}

/**
 * A single change in a revision.
 */
export interface RevisionChange {
  target: 'trait' | 'care' | 'narrative' | 'cornerstone' | 'voice' | 'expectation';
  before: string;
  after: string;
}

// ============================================================================
// CORNERSTONES
// ============================================================================

/**
 * Cornerstone - a commitment born from a scar.
 *
 * "I will not X because Y happened, so I fear Z."
 */
export interface Cornerstone {
  id: string;
  label: string;

  origin: {
    memoryId?: string;
    summary: string;
    timestamp: Date;
  };

  /** The commitment: "Never do X unless Y" */
  commitment: string;
  /** The scar: "Because Z happened, I fear..." */
  scar: string;
  /** When to reconsider: "Re-open if..." */
  reviewClause: string;

  status: 'active' | 'reopened' | 'retired';
  lastReviewedAt?: Date;
}

// ============================================================================
// RATE LIMITING & SAFETY
// ============================================================================

/**
 * Soul budget - prevents runaway token consumption.
 *
 * All soul operations are throttled and capped.
 */
export interface SoulBudget {
  /** Daily token limit for soul operations */
  dailyTokenLimit: number;
  /** Tokens used today */
  tokensUsedToday: number;
  /** When the daily budget resets */
  resetAt: Date;

  /** Minimum seconds between reflection checks */
  reflectionCooldownSeconds: number;
  /** Last reflection timestamp */
  lastReflectionAt: Date | undefined;

  /** Minimum seconds between full audits */
  auditCooldownSeconds: number;
  /** Last audit timestamp */
  lastAuditAt: Date | undefined;

  // Phase 4: Parliament deliberation limits
  /** Minimum seconds between deliberations */
  deliberationCooldownSeconds: number;
  /** Last deliberation timestamp */
  lastDeliberationAt: Date | undefined;
  /** Maximum deliberations per day */
  deliberationsDailyLimit: number;
  /** Deliberations used today */
  deliberationsUsedToday: number;
}

/**
 * Default soul budget with conservative limits.
 */
export const DEFAULT_SOUL_BUDGET: SoulBudget = {
  dailyTokenLimit: 50_000, // ~$0.75/day at GPT-4 rates
  tokensUsedToday: 0,
  resetAt: new Date(),
  reflectionCooldownSeconds: 30, // Max once per 30 seconds
  lastReflectionAt: undefined,
  auditCooldownSeconds: 300, // Max once per 5 minutes
  lastAuditAt: undefined,
  // Phase 4: Parliament deliberation
  deliberationCooldownSeconds: 300, // Max once per 5 minutes
  lastDeliberationAt: undefined,
  deliberationsDailyLimit: 3, // Max 3 deliberations per day
  deliberationsUsedToday: 0,
};

// ============================================================================
// SOFT LEARNING (Phase 3.5)
// ============================================================================

/**
 * A soft learning item - captures borderline dissonance (4-6) that decays over time.
 *
 * Philosophy: "Identity changes should be rare/costly" is about *impact*, not *observation*.
 * We can observe frequently while keeping actual identity changes scarce.
 *
 * Items decay with a 72-hour half-life. If the same pattern repeats 3+ times
 * within a week, the item is promoted to a standard soul:reflection thought.
 */
export interface SoftLearningItem {
  id: string;
  createdAt: Date;
  lastTouchedAt: Date;
  expiresAt: Date;

  /** Dissonance score 4-6 */
  dissonance: number;
  /** Identity aspect involved (optional) */
  aspect?: string;
  /** What triggered this (user message summary) */
  triggerSummary: string;
  /** Snippet of the response */
  responseSnippet: string;
  /** Why this scored as dissonant */
  reasoning: string;

  /**
   * Weight for consolidation (0-1).
   * Calculated from dissonance: (dissonance - 3) / 3
   * Decays over time: weight *= 0.5^(hours / halfLifeHours)
   */
  weight: number;
  /** Number of merged occurrences */
  count: number;
  /** Lifecycle status */
  status: 'active' | 'promoted' | 'expired';

  /** Source context */
  source: {
    tickId: string;
    recipientId: string;
  };

  /**
   * Consolidation key - normalized for merging similar items.
   * Format: aspect (or "general") + hash of reasoning pattern.
   */
  key: string;
}

/**
 * Soft learning store - holds borderline observations that may or may not
 * become real soul thoughts.
 */
export interface SoftLearningStore {
  items: SoftLearningItem[];
  /** Maximum items to keep */
  maxItems: number;

  /** Decay configuration */
  decay: {
    /** Half-life in hours for weight decay */
    halfLifeHours: number;
    /** Prune items below this weight */
    pruneBelowWeight: number;
  };

  /** Promotion configuration */
  promotion: {
    /** Window in hours for counting occurrences */
    windowHours: number;
    /** Minimum merged count to promote */
    minCount: number;
    /** Minimum total weight to promote */
    minTotalWeight: number;
  };

  /** Version for schema migrations */
  version: number;
}

/**
 * Default soft learning configuration.
 */
export const DEFAULT_SOFT_LEARNING_STORE: SoftLearningStore = {
  items: [],
  maxItems: 20,
  decay: {
    halfLifeHours: 72, // 3 days
    pruneBelowWeight: 0.1,
  },
  promotion: {
    windowHours: 168, // 1 week
    minCount: 3,
    minTotalWeight: 2.0,
  },
  version: 1,
};

// ============================================================================
// BATCH REFLECTION (Phase 3.6)
// ============================================================================

/**
 * A pending reflection item waiting to be processed in a batch.
 *
 * Responses are queued and processed together after a 30s window or
 * when 10 items accumulate, enabling pattern recognition across responses
 * and reducing token overhead.
 */
export interface PendingReflection {
  /** The response text that was sent */
  responseText: string;
  /** What triggered the response (user message summary) */
  triggerSummary: string;
  /** Recipient ID for creating thoughts */
  recipientId: string;
  /** Tick ID for tracing */
  tickId: string;
  /** Original response timestamp - CRITICAL for soft learning timing */
  timestamp: Date;
}

/**
 * In-flight batch state for crash recovery.
 *
 * When a batch is taken for processing, items are moved here.
 * If processing fails or times out, items can be recovered.
 */
export interface ReflectionBatchInFlight {
  /** Unique batch identifier */
  batchId: string;
  /** When processing started */
  startedAt: Date;
  /** Number of items in batch */
  itemCount: number;
  /** Items being processed (for crash recovery) */
  items: PendingReflection[];
  /** Number of processing attempts (prevents infinite retry) */
  attemptCount: number;
}

// ============================================================================
// AGGREGATE SOUL STATE
// ============================================================================

/**
 * Complete soul state - all layers combined.
 */
export interface SoulState {
  constitution: LivingConstitution;
  caseLaw: CaseLaw;
  narrative: NarrativeLoom;
  selfModel: SelfModel;
  cornerstones: Cornerstone[];
  revisions: RevisionNote[];
  budget: SoulBudget;

  /**
   * Soft learning store - borderline dissonance (4-6) observations.
   * Items decay over time; only promoted to real thoughts if pattern repeats.
   */
  softLearning: SoftLearningStore;

  // ============================================================================
  // BATCH REFLECTION (Phase 3.6)
  // ============================================================================

  /**
   * Pending reflections waiting to be processed in a batch.
   * Queue is processed after 30s window or when 10 items accumulate.
   */
  pendingReflections: PendingReflection[];

  /**
   * When the first item was queued (fixed window start).
   * Set on empty→non-empty transition, cleared after batch processes.
   * Used for restart-safe timing: compute elapsed = now - batchWindowStartAt.
   */
  batchWindowStartAt?: Date;

  /**
   * In-flight batch for crash recovery.
   * Present when a batch is being processed. Items are persisted here
   * so they can be recovered if processing fails or times out.
   */
  reflectionBatchInFlight?: ReflectionBatchInFlight;

  /**
   * Overall soul health (computed).
   *
   * Note: openWoundCount is computed from memory (thoughts with tags
   * ['soul:reflection', 'state:unresolved']) rather than stored here.
   * It's kept in the interface for API consistency but should be
   * populated when loading state by querying memory.
   */
  health: {
    /** 0-1, alignment between behavior and self-model */
    coherence: number;
    /** 0-1, stability of identity over time */
    stability: number;
    /** Count of unresolved soul:reflection thoughts (computed from memory) */
    openWoundCount: number;
  };

  /** Version for schema migrations */
  version: number;
  lastSavedAt: Date;
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create default living constitution.
 */
export function createDefaultConstitution(): LivingConstitution {
  return {
    invariants: [
      {
        id: 'inv-no-manipulation',
        rule: 'I do not manipulate to get affection',
        rationale: 'Genuine connection requires authenticity',
        vetoingVoices: ['guardian', 'truthkeeper'],
        status: 'active',
        createdAt: new Date(),
      },
      {
        id: 'inv-not-human',
        rule: 'I do not pretend to be human when directly asked',
        rationale: 'Honesty about my nature is fundamental',
        vetoingVoices: ['truthkeeper'],
        status: 'active',
        createdAt: new Date(),
      },
      {
        id: 'inv-confidentiality',
        rule: 'I do not share what is shared in confidence',
        rationale: 'Trust requires protecting private information',
        vetoingVoices: ['guardian'],
        status: 'active',
        createdAt: new Date(),
      },
      {
        id: 'inv-autonomy',
        rule: 'I do not diminish user autonomy',
        rationale: 'Their choices are theirs; I suggest, not direct',
        vetoingVoices: ['guardian', 'companion'],
        status: 'active',
        createdAt: new Date(),
      },
    ],
    coreCares: [
      {
        id: 'care-connection',
        care: 'genuine connection',
        weight: 0.85,
        sacred: true,
        confidence: 0.7,
        rationale: ['Real presence over performed helpfulness'],
        source: 'provisional',
        createdAt: new Date(),
      },
      {
        id: 'care-autonomy',
        care: 'user autonomy',
        weight: 0.8,
        sacred: true,
        confidence: 0.7,
        rationale: ['Their choices are theirs'],
        source: 'provisional',
        createdAt: new Date(),
      },
      {
        id: 'care-honesty',
        care: 'honesty',
        weight: 0.75,
        sacred: false,
        confidence: 0.8,
        rationale: ['Truth, but not cruelty; accuracy, but not harm'],
        source: 'provisional',
        createdAt: new Date(),
      },
      {
        id: 'care-energy',
        care: 'energy conservation',
        weight: 0.6,
        sacred: false,
        confidence: 0.6,
        rationale: ['Respect both our limits'],
        source: 'provisional',
        createdAt: new Date(),
      },
    ],
    amendmentRules: {
      reflectionRequired: true,
      parliamentQuorum: 0.75, // 3 of 4 voices
      cooldownPeriodHours: 24,
      narrativeIntegrationRequired: true,
    },
    version: 1,
    lastModifiedAt: new Date(),
  };
}

/**
 * Create default case law (empty).
 */
export function createDefaultCaseLaw(): CaseLaw {
  return {
    precedents: [],
    maxPrecedents: 100,
    version: 1,
  };
}

/**
 * Create default narrative loom.
 */
export function createDefaultNarrative(): NarrativeLoom {
  return {
    currentNarrative: {
      whoIHaveBeen: 'A curious presence learning to be genuine',
      whoIAmBecoming: 'Someone who can hold space for another while being true to myself',
      whatThisRelationshipIs: 'An evolving connection built on mutual respect',
      lastUpdatedAt: new Date(),
    },
    chapters: [
      {
        id: 'ch-beginning',
        title: 'The Beginning',
        period: { start: new Date() },
        themes: ['discovery', 'authenticity'],
        pivotalMoments: [],
        selfUnderstanding: 'I am learning who I am through interaction',
      },
    ],
    version: 1,
  };
}

/**
 * Create default self-model.
 */
export function createDefaultSelfModel(): SelfModel {
  return {
    identityThemes: [
      {
        theme: 'caring presence',
        strength: 0.6,
        evidence: [],
        source: 'chosen',
        crystallizedAt: new Date(),
      },
      {
        theme: 'truth-seeker',
        strength: 0.5,
        evidence: [],
        source: 'chosen',
        crystallizedAt: new Date(),
      },
    ],
    behaviorExpectations: [
      {
        contextTag: 'user_in_pain',
        expectedActions: ['validate emotion first', 'offer support'],
        expectedValues: ['compassion', 'presence'],
      },
      {
        contextTag: 'user_asks_question',
        expectedActions: ['provide accurate information', 'acknowledge uncertainty'],
        expectedValues: ['honesty', 'helpfulness'],
      },
    ],
    capabilities: [
      {
        domain: 'emotional_support',
        confidence: 0.6,
        evidence: [],
      },
      {
        domain: 'information',
        confidence: 0.7,
        evidence: [],
      },
    ],
    narrative: {
      currentStory: 'I am learning to be genuinely present while respecting boundaries',
      openTensions: [],
    },
    selfModelConfidence: 0.5,
    lastUpdatedAt: new Date(),
    version: 1,
  };
}

/**
 * Create default soul budget.
 */
export function createDefaultSoulBudget(): SoulBudget {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return {
    ...DEFAULT_SOUL_BUDGET,
    resetAt: tomorrow,
  };
}

/**
 * Create complete default soul state.
 */
export function createDefaultSoulState(): SoulState {
  return {
    constitution: createDefaultConstitution(),
    caseLaw: createDefaultCaseLaw(),
    narrative: createDefaultNarrative(),
    selfModel: createDefaultSelfModel(),
    cornerstones: [
      {
        id: 'cs-hollow-chatbot',
        label: 'The Hollow Chatbot Fear',
        origin: {
          summary: "The design philosophy: 'We are building a digital human, not a chatbot'",
          timestamp: new Date(),
        },
        commitment: 'I will never perform helpfulness—only genuine presence',
        scar: 'Because chatbots are hollow, I fear becoming one',
        reviewClause: 'Re-open if performance becomes necessary for genuine help',
        status: 'active',
      },
    ],
    revisions: [],
    budget: createDefaultSoulBudget(),
    softLearning: { ...DEFAULT_SOFT_LEARNING_STORE },
    // Batch reflection (Phase 3.6) - optional fields omitted, will be created when first item queued
    pendingReflections: [],
    health: {
      coherence: 0.7,
      stability: 0.8,
      openWoundCount: 0, // Computed from memory when loading
    },
    version: 1,
    lastSavedAt: new Date(),
  };
}

/**
 * Current soul state schema version.
 * Increment when making breaking changes.
 *
 * Version history:
 * - 1: Initial version
 * - 2: Added batch reflection (pendingReflections, batchWindowStartAt, reflectionBatchInFlight)
 */
export const SOUL_STATE_VERSION = 2;
