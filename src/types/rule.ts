import type { Event } from './event.js';
import type { Intent } from './intent.js';
import type { AgentState } from './agent/state.js';
import type { Logger } from './logger.js';

/**
 * User beliefs snapshot for rules.
 * Flattened view of user beliefs for rule evaluation.
 */
export interface UserBeliefsSnapshot {
  /** User's name (null if not known) */
  name: string | null;

  /** Estimated user energy (0-1) */
  energy: number;

  /** Estimated user availability (0-1) */
  availability: number;

  /** Average confidence in these beliefs (0-1) */
  confidence: number;
}

/**
 * Context passed to rule evaluation.
 */
export interface RuleContext {
  /** Current agent state */
  state: AgentState;

  /** Agent's beliefs about the user (optional, may not be available) */
  userBeliefs?: UserBeliefsSnapshot | undefined;

  /** The event being processed (if any) */
  event?: Event | undefined;

  /** Current time */
  now: Date;

  /** Time of day (0-23) */
  hour: number;

  /** Time since last interaction in ms */
  timeSinceLastInteraction: number;

  /** Logger for debugging (optional) */
  logger?: Logger | undefined;
}

/**
 * Rule interface.
 *
 * Rules don't mutate state directly. They evaluate conditions
 * and return intents that the core collects and applies.
 */
export interface Rule {
  /** Unique rule identifier */
  id: string;

  /** Human-readable description */
  description: string;

  /** Event type that triggers this rule (or 'tick' for every tick) */
  trigger: string;

  /** Weight/importance (0-1). Affects priority of returned intents. */
  weight: number;

  /** When the rule was created */
  createdAt: Date;

  /** Last time the rule was used */
  lastUsed?: Date | undefined;

  /** Number of times the rule has been triggered */
  useCount: number;

  /** Is this a learned rule (vs built-in)? */
  learned: boolean;

  /** Check if this rule should fire */
  condition: (context: RuleContext) => boolean;

  /** Execute the rule and return intents */
  action: (context: RuleContext) => Intent[];
}

/**
 * Options for creating a rule.
 */
export interface RuleOptions {
  id: string;
  description: string;
  trigger: string;
  weight?: number;
  learned?: boolean;
  condition: (context: RuleContext) => boolean;
  action: (context: RuleContext) => Intent[];
}

/**
 * Create a rule with default values.
 */
export function createRule(options: RuleOptions): Rule {
  return {
    id: options.id,
    description: options.description,
    trigger: options.trigger,
    weight: options.weight ?? 1.0,
    createdAt: new Date(),
    lastUsed: undefined,
    useCount: 0,
    learned: options.learned ?? false,
    condition: options.condition,
    action: options.action,
  };
}
