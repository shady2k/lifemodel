import type { SignalType } from '../models/user-model.js';

/**
 * Feedback type from user interaction.
 */
export type FeedbackType = 'positive' | 'neutral' | 'negative';

/**
 * Feedback signal with metadata.
 */
export interface FeedbackSignal {
  /** The type of feedback */
  type: FeedbackType;
  /** Strength of the signal (0-1) */
  strength: number;
  /** What triggered this feedback */
  source: SignalType;
  /** Timestamp of the feedback */
  timestamp: Date;
  /** Additional context */
  metadata?: Record<string, unknown>;
}

/**
 * A recorded behavior that can be reinforced.
 */
export interface RecordedBehavior {
  /** Unique ID */
  id: string;
  /** Type of behavior */
  type: 'proactive_contact' | 'response' | 'timing';
  /** When the behavior occurred */
  timestamp: Date;
  /** Context at the time of behavior */
  context: {
    /** Contact pressure at the time */
    contactPressure?: number;
    /** Hour of day */
    hour: number;
    /** User availability estimate */
    userAvailability?: number;
    /** Agent energy */
    energy?: number;
  };
  /** Which weights were involved in the decision */
  involvedWeights: string[];
  /** Whether feedback has been received for this behavior */
  feedbackReceived: boolean;
}

/**
 * Mapping from signal type to feedback classification.
 */
export interface SignalFeedbackMapping {
  /** The signal type from user model */
  signal: SignalType;
  /** Classified feedback type */
  feedbackType: FeedbackType;
  /** Base strength of this signal (0-1) */
  baseStrength: number;
}

/**
 * Learning configuration.
 */
export interface LearningConfig {
  /** Learning rate for contact timing weights (fast adaptation) */
  contactTimingRate: number;
  /** Learning rate for personality weights (very slow) */
  personalityRate: number;
  /** Learning rate for topic preferences (moderate) */
  topicPreferenceRate: number;
  /** Maximum age of behaviors to consider for feedback (ms) */
  behaviorMaxAge: number;
  /** Maximum number of behaviors to keep in history */
  maxBehaviorHistory: number;
}

/**
 * Default learning configuration.
 */
export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  contactTimingRate: 0.1,
  personalityRate: 0.01,
  topicPreferenceRate: 0.05,
  behaviorMaxAge: 30 * 60 * 1000, // 30 minutes
  maxBehaviorHistory: 100,
};

/**
 * Default signal to feedback mappings.
 */
export const SIGNAL_FEEDBACK_MAPPINGS: SignalFeedbackMapping[] = [
  // Positive signals
  { signal: 'quick_response', feedbackType: 'positive', baseStrength: 0.8 },
  { signal: 'positive_tone', feedbackType: 'positive', baseStrength: 0.6 },
  { signal: 'explicit_free', feedbackType: 'positive', baseStrength: 0.9 },
  { signal: 'explicit_energetic', feedbackType: 'positive', baseStrength: 0.7 },

  // Negative signals
  { signal: 'slow_response', feedbackType: 'negative', baseStrength: 0.4 },
  { signal: 'no_response', feedbackType: 'negative', baseStrength: 0.7 },
  { signal: 'negative_tone', feedbackType: 'negative', baseStrength: 0.6 },
  { signal: 'explicit_busy', feedbackType: 'negative', baseStrength: 0.8 },
  { signal: 'explicit_tired', feedbackType: 'negative', baseStrength: 0.5 },

  // Neutral signals (don't affect learning much)
  { signal: 'message_received', feedbackType: 'neutral', baseStrength: 0.2 },
  { signal: 'message_read', feedbackType: 'neutral', baseStrength: 0.1 },
];
