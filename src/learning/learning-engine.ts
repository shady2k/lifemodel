import { randomUUID } from 'node:crypto';
import type { Logger } from '../types/index.js';
import type { SignalType } from '../models/user-model.js';
import type { ConfigurableNeuron } from '../decision/neuron.js';
import type { FeedbackSignal, RecordedBehavior, LearningConfig } from './types.js';
import { DEFAULT_LEARNING_CONFIG, SIGNAL_FEEDBACK_MAPPINGS } from './types.js';

/**
 * LearningEngine - updates neuron weights based on user feedback.
 *
 * The learning process:
 * 1. Agent performs behaviors (proactive contact, responses)
 * 2. Behaviors are recorded with context
 * 3. User provides implicit feedback (response time, tone)
 * 4. Feedback is classified (positive/negative/neutral)
 * 5. Relevant weights are updated based on feedback
 *
 * Weights that led to positive outcomes are strengthened.
 * Weights that led to negative outcomes are weakened.
 */
export class LearningEngine {
  private readonly logger: Logger;
  private readonly config: LearningConfig;

  // Neurons to update
  private contactPressureNeuron: ConfigurableNeuron | null = null;
  private alertnessNeuron: ConfigurableNeuron | null = null;

  // Behavior history
  private readonly behaviorHistory: RecordedBehavior[] = [];

  constructor(logger: Logger, config: Partial<LearningConfig> = {}) {
    this.logger = logger.child({ component: 'learning-engine' });
    this.config = { ...DEFAULT_LEARNING_CONFIG, ...config };
  }

  /**
   * Register neurons for learning.
   */
  registerNeurons(neurons: {
    contactPressure?: ConfigurableNeuron;
    alertness?: ConfigurableNeuron;
  }): void {
    if (neurons.contactPressure) {
      this.contactPressureNeuron = neurons.contactPressure;
      this.logger.debug('Contact pressure neuron registered for learning');
    }
    if (neurons.alertness) {
      this.alertnessNeuron = neurons.alertness;
      this.logger.debug('Alertness neuron registered for learning');
    }
  }

  /**
   * Record a behavior for potential reinforcement.
   *
   * Call this when the agent takes an action that can be reinforced.
   */
  recordBehavior(
    type: RecordedBehavior['type'],
    context: RecordedBehavior['context'],
    involvedWeights: string[]
  ): string {
    const behavior: RecordedBehavior = {
      id: randomUUID(),
      type,
      timestamp: new Date(),
      context,
      involvedWeights,
      feedbackReceived: false,
    };

    this.behaviorHistory.push(behavior);
    this.pruneOldBehaviors();

    this.logger.debug({ behaviorId: behavior.id, type, involvedWeights }, 'Behavior recorded');

    return behavior.id;
  }

  /**
   * Process a feedback signal from user interaction.
   *
   * This is typically called when UserModel processes a signal.
   */
  processFeedback(signal: SignalType, metadata?: Record<string, unknown>): void {
    // Map signal to feedback
    const mapping = SIGNAL_FEEDBACK_MAPPINGS.find((m) => m.signal === signal);
    if (!mapping) {
      this.logger.debug({ signal }, 'No feedback mapping for signal');
      return;
    }

    const feedback: FeedbackSignal = {
      type: mapping.feedbackType,
      strength: mapping.baseStrength,
      source: signal,
      timestamp: new Date(),
    };
    if (metadata) {
      feedback.metadata = metadata;
    }

    // Find recent behaviors to reinforce
    const recentBehaviors = this.findRecentBehaviors();
    if (recentBehaviors.length === 0) {
      this.logger.debug('No recent behaviors to reinforce');
      return;
    }

    // Apply learning to each relevant behavior
    for (const behavior of recentBehaviors) {
      this.applyLearning(behavior, feedback);
      behavior.feedbackReceived = true;
    }

    this.logger.debug(
      {
        signal,
        feedbackType: feedback.type,
        strength: feedback.strength,
        behaviorsUpdated: recentBehaviors.length,
      },
      'Feedback processed'
    );
  }

  /**
   * Find recent behaviors that haven't received feedback yet.
   */
  private findRecentBehaviors(): RecordedBehavior[] {
    const now = Date.now();
    const maxAge = this.config.behaviorMaxAge;

    return this.behaviorHistory.filter((b) => {
      const age = now - b.timestamp.getTime();
      return age <= maxAge && !b.feedbackReceived;
    });
  }

  /**
   * Apply learning to a behavior based on feedback.
   */
  private applyLearning(behavior: RecordedBehavior, feedback: FeedbackSignal): void {
    // Determine delta direction
    let delta: number;
    switch (feedback.type) {
      case 'positive':
        delta = this.config.contactTimingRate * feedback.strength;
        break;
      case 'negative':
        delta = -this.config.contactTimingRate * feedback.strength;
        break;
      case 'neutral':
        // Neutral feedback has minimal effect
        delta = this.config.contactTimingRate * feedback.strength * 0.1;
        break;
    }

    // Update weights in contact pressure neuron
    if (this.contactPressureNeuron && behavior.type === 'proactive_contact') {
      for (const weightName of behavior.involvedWeights) {
        if (this.contactPressureNeuron.hasInput(weightName)) {
          const newWeight = this.contactPressureNeuron.updateWeight(weightName, delta);
          if (newWeight !== null) {
            this.logger.debug(
              {
                neuron: 'contactPressure',
                weight: weightName,
                delta: delta.toFixed(4),
                newWeight: newWeight.toFixed(4),
                feedbackType: feedback.type,
              },
              'Weight updated'
            );
          }
        }
      }
    }

    // Update alertness neuron for timing-related behaviors
    if (this.alertnessNeuron && behavior.type === 'timing') {
      for (const weightName of behavior.involvedWeights) {
        if (this.alertnessNeuron.hasInput(weightName)) {
          const newWeight = this.alertnessNeuron.updateWeight(weightName, delta);
          if (newWeight !== null) {
            this.logger.debug(
              {
                neuron: 'alertness',
                weight: weightName,
                delta: delta.toFixed(4),
                newWeight: newWeight.toFixed(4),
                feedbackType: feedback.type,
              },
              'Weight updated'
            );
          }
        }
      }
    }
  }

  /**
   * Remove old behaviors from history.
   */
  private pruneOldBehaviors(): void {
    const now = Date.now();
    const maxAge = this.config.behaviorMaxAge * 2; // Keep a bit longer than needed

    // Remove old behaviors
    while (this.behaviorHistory.length > 0) {
      const oldest = this.behaviorHistory[0];
      if (oldest && now - oldest.timestamp.getTime() > maxAge) {
        this.behaviorHistory.shift();
      } else {
        break;
      }
    }

    // Enforce max history size
    while (this.behaviorHistory.length > this.config.maxBehaviorHistory) {
      this.behaviorHistory.shift();
    }
  }

  /**
   * Get current neuron weights for persistence.
   */
  getNeuronWeights(): {
    contactPressure: Record<string, number>;
    alertness: Record<string, number>;
  } {
    return {
      contactPressure: this.contactPressureNeuron?.getWeights() ?? {},
      alertness: this.alertnessNeuron?.getWeights() ?? {},
    };
  }

  /**
   * Restore neuron weights from persistence.
   */
  setNeuronWeights(weights: {
    contactPressure?: Record<string, number>;
    alertness?: Record<string, number>;
  }): void {
    if (weights.contactPressure && this.contactPressureNeuron) {
      this.contactPressureNeuron.setWeights(weights.contactPressure);
      this.logger.debug({ weights: weights.contactPressure }, 'Contact pressure weights restored');
    }
    if (weights.alertness && this.alertnessNeuron) {
      this.alertnessNeuron.setWeights(weights.alertness);
      this.logger.debug({ weights: weights.alertness }, 'Alertness weights restored');
    }
  }

  /**
   * Get learning statistics.
   */
  getStats(): {
    behaviorHistorySize: number;
    unreinforcedBehaviors: number;
  } {
    return {
      behaviorHistorySize: this.behaviorHistory.length,
      unreinforcedBehaviors: this.behaviorHistory.filter((b) => !b.feedbackReceived).length,
    };
  }

  /**
   * Clear behavior history (for testing).
   */
  clearHistory(): void {
    this.behaviorHistory.length = 0;
  }
}

/**
 * Factory function for creating a learning engine.
 */
export function createLearningEngine(
  logger: Logger,
  config?: Partial<LearningConfig>
): LearningEngine {
  return new LearningEngine(logger, config);
}
