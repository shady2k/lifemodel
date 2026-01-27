/**
 * Learning module exports.
 */

export type {
  FeedbackType,
  FeedbackSignal,
  RecordedBehavior,
  SignalFeedbackMapping,
  LearningConfig,
} from './types.js';
export { DEFAULT_LEARNING_CONFIG, SIGNAL_FEEDBACK_MAPPINGS } from './types.js';
export { LearningEngine, createLearningEngine } from './learning-engine.js';
