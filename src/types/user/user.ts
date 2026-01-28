import type { Person } from './person.js';
import type { Belief } from '../belief.js';
import { createBelief } from '../belief.js';

/**
 * User - the primary person the agent interacts with.
 *
 * Unlike Person, User has detailed state tracking including
 * the agent's **beliefs** about the user (not ground truth).
 *
 * Note: Use isNameKnown(user) from person.ts to check if name is known.
 */
export interface User extends Person {
  /**
   * Agent's beliefs about user's current state.
   * Each belief has confidence that builds with evidence and decays over time.
   */
  beliefs: UserBeliefs;

  /**
   * Detected patterns in user behavior.
   */
  patterns: UserPatterns;

  /**
   * User preferences learned over time.
   */
  preferences: UserPreferences;

  /**
   * Timezone offset in hours from UTC (e.g., +3 for Moscow).
   * Used for time-of-day calculations.
   */
  timezoneOffset: number;
}

/**
 * Agent's beliefs about user's current state.
 */
export interface UserBeliefs {
  /** Estimated energy level (0-1) */
  energy: Belief<number>;

  /** Current mood */
  mood: Belief<UserMood>;

  /** Estimated availability (0-1) */
  availability: Belief<number>;
}

/**
 * Possible user moods (agent's belief).
 */
export type UserMood =
  | 'unknown'
  | 'positive'
  | 'neutral'
  | 'negative'
  | 'stressed'
  | 'tired'
  | 'excited';

/**
 * Detected patterns in user behavior.
 */
export interface UserPatterns {
  /** Typical wake time (hour, 0-23) */
  wakeHour: number | null;

  /** Typical sleep time (hour, 0-23) */
  sleepHour: number | null;

  /** Average response time in seconds */
  avgResponseTime: number | null;

  /** Hours when user is typically most active */
  activeHours: number[];

  /** Hours when user typically doesn't respond */
  quietHours: number[];
}

/**
 * User preferences learned over time.
 */
export interface UserPreferences {
  /** Preferred communication style */
  communicationStyle: 'brief' | 'detailed' | 'unknown';

  /** User's preferred language (detected from their messages) */
  language: string | null;

  /**
   * User's gender (for languages with grammatical gender like Russian).
   * Should be detected from context or explicit statement.
   */
  gender: 'male' | 'female' | 'unknown';

  /** Topics user enjoys discussing */
  favoriteTopics: string[];

  /** Topics user avoids or dislikes */
  avoidTopics: string[];

  /** Whether user likes morning messages */
  morningMessages: boolean | null;

  /** Whether user likes evening check-ins */
  eveningMessages: boolean | null;
}

/**
 * Default user patterns.
 */
export function createDefaultPatterns(): UserPatterns {
  return {
    wakeHour: 8,
    sleepHour: 23,
    avgResponseTime: null,
    activeHours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
    quietHours: [0, 1, 2, 3, 4, 5, 6, 23],
  };
}

/**
 * Default user preferences.
 */
export function createDefaultPreferences(): UserPreferences {
  return {
    communicationStyle: 'unknown',
    language: null,
    gender: 'unknown',
    favoriteTopics: [],
    avoidTopics: [],
    morningMessages: null,
    eveningMessages: null,
  };
}

/**
 * Create default user beliefs.
 */
export function createDefaultBeliefs(): UserBeliefs {
  return {
    energy: createBelief(0.5, 0.3, 'default'),
    mood: createBelief<UserMood>('unknown', 0.3, 'default'),
    availability: createBelief(0.5, 0.3, 'default'),
  };
}

/**
 * Create a new user with defaults.
 *
 * @param id - User's unique identifier
 * @param name - User's name (null if unknown)
 * @param timezoneOffset - Timezone offset from UTC in hours
 */
export function createUser(id: string, name: string | null = null, timezoneOffset = 0): User {
  return {
    id,
    name,
    traits: [],
    topics: [],
    lastMentioned: new Date(),
    beliefs: createDefaultBeliefs(),
    patterns: createDefaultPatterns(),
    preferences: createDefaultPreferences(),
    timezoneOffset,
  };
}
