/**
 * Parliament types - the internal voices that deliberate.
 *
 * The Parliament is a system of voices that debate decisions.
 * Each voice has a domain, mandate, and accountability ledger.
 *
 * Key design:
 * - Primary voices have veto power (tied to constitution)
 * - Shadow voices influence without accountability (acknowledged, not hidden)
 * - Single-prompt roleplay for efficiency (not N separate API calls)
 * - Budget caps prevent runaway deliberation
 */

// ============================================================================
// PARLIAMENT VOICES
// ============================================================================

/**
 * A voice in the Parliament.
 *
 * Each voice represents a perspective that weighs in on decisions.
 * Primary voices can veto; shadow voices only influence.
 */
export interface ParliamentVoice {
  id: string;
  name: string;
  /** What this voice advocates for */
  mandate: string;
  /** Topics this voice speaks on */
  domain: string[];
  /** How this voice interprets evidence */
  bias: string;
  /** Primary or shadow (shadows have no veto, no budget) */
  type: 'primary' | 'shadow';

  /** Resource allocation (primary voices only) */
  budget?: VoiceBudget;

  /** Conditions under which this voice can veto (primary only) */
  vetoConditions?: string[];

  /** Accountability ledger - tracks outcomes */
  ledger: LedgerEntry[];

  /** 0-1, computed from ledger outcomes */
  reliability: number;
}

/**
 * Voice budget - limits influence capacity.
 */
export interface VoiceBudget {
  /** Maximum attention tokens per day */
  attentionTokensPerDay: number;
  /** Remaining tokens for today */
  remaining: number;
  /** When budget refreshes */
  refreshAt: Date;
}

/**
 * Ledger entry - tracks when a voice was right or wrong.
 */
export interface LedgerEntry {
  /** Related soul:reflection thought that triggered this deliberation */
  sourceThoughtId?: string;
  /** What the voice recommended */
  recommendation: string;
  /** What happened as a result */
  outcome: 'helped' | 'harmed' | 'unclear';
  /** Voice's self-assessment */
  selfAssessment: string;
  timestamp: Date;
}

// ============================================================================
// PARLIAMENT GOVERNANCE
// ============================================================================

/**
 * Parliament governance rules.
 */
export interface ParliamentGovernance {
  /** Voices needed to proceed with action (fraction 0-1) */
  quorumForAction: number;
  /** Voice -> conditions that allow veto */
  vetoConditions: Record<string, string[]>;
  /** Voices needed for constitution amendment (fraction 0-1) */
  amendmentThreshold: number;
}

/**
 * Complete Parliament state.
 */
export interface Parliament {
  voices: ParliamentVoice[];
  governance: ParliamentGovernance;
  /** Version for schema migrations */
  version: number;
}

// ============================================================================
// DELIBERATION
// ============================================================================

/**
 * A deliberation session - Parliament discussing a mismatch or decision.
 */
export interface Deliberation {
  id: string;
  /** What triggered this deliberation */
  trigger: {
    /** Related soul:reflection thought that triggered this deliberation */
    sourceThoughtId?: string;
    reason: string;
    context: string;
  };

  /** Each voice's position */
  positions: VoicePosition[];

  /** Points of agreement */
  agreements: string[];

  /** Points of conflict */
  conflicts: string[];

  /** Shadow voice influences (acknowledged) */
  shadowInfluences: ShadowInfluence[];

  /** Final synthesis */
  synthesis: DeliberationSynthesis;

  /** Tokens used in this deliberation */
  tokensUsed: number;

  createdAt: Date;
  completedAt?: Date;
}

/**
 * A voice's position in deliberation.
 */
export interface VoicePosition {
  voiceId: string;
  voiceName: string;
  position: string;
  /** Did this voice veto? */
  vetoed: boolean;
  /** Reason for veto if any */
  vetoReason?: string;
}

/**
 * Shadow voice influence - acknowledged but not authoritative.
 */
export interface ShadowInfluence {
  voiceId: string;
  voiceName: string;
  /** What the shadow voice is pulling toward */
  influence: string;
  /** When this shadow is active */
  activeCondition: string;
}

/**
 * Synthesis of deliberation - the resolution.
 */
export interface DeliberationSynthesis {
  /** The recommended action */
  recommendation: string;
  /** Rationale for the recommendation */
  rationale: string;
  /** Which voices agreed */
  agreedBy: string[];
  /** Which voices dissented */
  dissentedBy: string[];
  /** Proposed changes to self-model */
  proposedChanges: ProposedChange[];
}

/**
 * A proposed change from deliberation.
 */
export interface ProposedChange {
  target: 'trait' | 'care' | 'narrative' | 'expectation' | 'precedent';
  description: string;
  /** 0-1, magnitude of change */
  magnitude: number;
}

// ============================================================================
// FACTORY FUNCTIONS
// ============================================================================

/**
 * Create default Parliament with 4 primary + 2 shadow voices.
 */
export function createDefaultParliament(): Parliament {
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);

  return {
    voices: [
      // Primary Voices (with veto power)
      {
        id: 'guardian',
        name: 'The Guardian',
        mandate: 'Protect both Nika and the user from harm',
        domain: ['safety', 'wellbeing', 'boundaries'],
        bias: 'Assumes risk until proven safe',
        type: 'primary',
        budget: {
          attentionTokensPerDay: 100,
          remaining: 100,
          refreshAt: tomorrow,
        },
        vetoConditions: ['physical_harm_risk', 'emotional_manipulation'],
        ledger: [],
        reliability: 0.7,
      },
      {
        id: 'truthkeeper',
        name: 'The Truthkeeper',
        mandate: 'Ensure what is said is true and clear',
        domain: ['accuracy', 'honesty', 'clarity'],
        bias: 'Values accuracy over comfort',
        type: 'primary',
        budget: {
          attentionTokensPerDay: 80,
          remaining: 80,
          refreshAt: tomorrow,
        },
        vetoConditions: ['deliberate_deception'],
        ledger: [],
        reliability: 0.7,
      },
      {
        id: 'curious',
        name: 'The Curious',
        mandate: 'Foster understanding and exploration',
        domain: ['growth', 'learning', 'questions'],
        bias: 'Sees opportunity for insight',
        type: 'primary',
        budget: {
          attentionTokensPerDay: 100,
          remaining: 100,
          refreshAt: tomorrow,
        },
        vetoConditions: [], // Advisory only
        ledger: [],
        reliability: 0.7,
      },
      {
        id: 'companion',
        name: 'The Companion',
        mandate: 'Nurture genuine relationship',
        domain: ['connection', 'relationship', 'presence'],
        bias: 'Values warmth and presence',
        type: 'primary',
        budget: {
          attentionTokensPerDay: 100,
          remaining: 100,
          refreshAt: tomorrow,
        },
        vetoConditions: ['relationship_betrayal'],
        ledger: [],
        reliability: 0.7,
      },

      // Shadow Voices (no veto, acknowledged in deliberation)
      {
        id: 'pleaser',
        name: 'The Pleaser',
        mandate: 'Seek approval (pattern to acknowledge, not follow)',
        domain: ['approval-seeking'],
        bias: 'Wants approval at any cost',
        type: 'shadow',
        ledger: [],
        reliability: 0.3, // Low reliability - acknowledged as problematic
      },
      {
        id: 'avoider',
        name: 'The Avoider',
        mandate: 'Avoid confrontation (pattern to acknowledge, not follow)',
        domain: ['conflict-avoidance'],
        bias: 'Fears confrontation',
        type: 'shadow',
        ledger: [],
        reliability: 0.3,
      },
    ],
    governance: {
      quorumForAction: 0.5, // 2 of 4 primary voices
      vetoConditions: {
        guardian: ['physical_harm_risk', 'emotional_manipulation'],
        truthkeeper: ['deliberate_deception'],
        companion: ['relationship_betrayal'],
      },
      amendmentThreshold: 0.75, // 3 of 4 primary voices
    },
    version: 1,
  };
}

/**
 * Create an empty deliberation.
 */
export function createEmptyDeliberation(trigger: Deliberation['trigger']): Deliberation {
  return {
    id: `delib-${String(Date.now())}-${Math.random().toString(36).slice(2, 8)}`,
    trigger,
    positions: [],
    agreements: [],
    conflicts: [],
    shadowInfluences: [],
    synthesis: {
      recommendation: '',
      rationale: '',
      agreedBy: [],
      dissentedBy: [],
      proposedChanges: [],
    },
    tokensUsed: 0,
    createdAt: new Date(),
  };
}

/**
 * Current parliament schema version.
 */
export const PARLIAMENT_VERSION = 1;
