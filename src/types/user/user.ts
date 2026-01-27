import type { Person } from './person.js';

/**
 * User - the primary person the agent interacts with.
 *
 * Unlike Person, User has detailed state tracking including
 * the agent's **beliefs** about the user (not ground truth).
 */
export interface User extends Person {
  /**
   * Agent's estimate of user's energy level (0-1).
   * Based on time of day, response patterns, explicit signals.
   * This is a BELIEF, not truth.
   */
  energy: number;

  /**
   * Agent's belief about user's current mood.
   */
  mood: UserMood;

  /**
   * Agent's estimate of user's availability (0-1).
   * 0 = definitely busy/unavailable
   * 1 = definitely free/available
   */
  availability: number;

  /**
   * Confidence in current beliefs (0-1).
   * Decays over time without new signals.
   */
  confidence: number;

  /**
   * Last time beliefs were updated from a direct signal.
   */
  lastSignalAt: Date;

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
    favoriteTopics: [],
    avoidTopics: [],
    morningMessages: null,
    eveningMessages: null,
  };
}

/**
 * Create a new user with defaults.
 */
export function createUser(id: string, name: string, timezoneOffset = 0): User {
  const now = new Date();
  return {
    id,
    name,
    traits: [],
    topics: [],
    lastMentioned: now,
    energy: 0.5,
    mood: 'unknown',
    availability: 0.5,
    confidence: 0.3, // Low initial confidence
    lastSignalAt: now,
    patterns: createDefaultPatterns(),
    preferences: createDefaultPreferences(),
    timezoneOffset,
  };
}
