import type { Logger } from '../types/index.js';
import type { User, UserPatterns } from '../types/user/user.js';
import { createUser } from '../types/user/user.js';

/**
 * Configuration for the user model.
 */
export interface UserModelConfig {
  /** How fast confidence decays per hour without signals (default: 0.02) */
  confidenceDecayRate: number;

  /** Minimum confidence level (default: 0.1) */
  minConfidence: number;

  /** Maximum confidence level (default: 0.95) */
  maxConfidence: number;

  /** How much a direct message boosts confidence (default: 0.3) */
  messageConfidenceBoost: number;

  /** How much an explicit signal boosts confidence (default: 0.5) */
  explicitSignalBoost: number;
}

const DEFAULT_CONFIG: UserModelConfig = {
  confidenceDecayRate: 0.02,
  minConfidence: 0.1,
  maxConfidence: 0.95,
  messageConfidenceBoost: 0.3,
  explicitSignalBoost: 0.5,
};

/**
 * Time-of-day energy profile.
 * Maps hours to expected energy levels.
 */
const DEFAULT_ENERGY_PROFILE: Record<number, number> = {
  0: 0.1, // Midnight - very low
  1: 0.05,
  2: 0.05,
  3: 0.05,
  4: 0.05,
  5: 0.1,
  6: 0.2, // Early morning - waking up
  7: 0.4,
  8: 0.6, // Morning - increasing
  9: 0.75,
  10: 0.85, // Mid-morning - high
  11: 0.9,
  12: 0.8, // Noon - slight dip (lunch)
  13: 0.7,
  14: 0.75, // Afternoon - recovering
  15: 0.8,
  16: 0.8,
  17: 0.75, // Late afternoon
  18: 0.7, // Evening - decreasing
  19: 0.65,
  20: 0.55,
  21: 0.45, // Night - winding down
  22: 0.3,
  23: 0.15, // Late night - low
};

/**
 * Signal types that can update user beliefs.
 */
export type SignalType =
  | 'message_received' // User sent a message
  | 'message_read' // User read our message (if available)
  | 'quick_response' // User responded quickly
  | 'slow_response' // User took a long time to respond
  | 'no_response' // User didn't respond
  | 'positive_tone' // Detected positive sentiment
  | 'negative_tone' // Detected negative sentiment
  | 'explicit_busy' // User said they're busy
  | 'explicit_free' // User said they're free
  | 'explicit_tired' // User said they're tired
  | 'explicit_energetic'; // User said they're doing well

/**
 * UserModel - manages agent's beliefs about the user.
 *
 * Key principle: these are BELIEFS, not ground truth.
 * The agent estimates user state based on:
 * - Time of day (primary for MVP)
 * - Response patterns
 * - Explicit signals from user
 *
 * Confidence decays over time without new signals.
 */
export class UserModel {
  private user: User;
  private readonly config: UserModelConfig;
  private readonly logger: Logger;
  private energyProfile: Record<number, number>;

  constructor(user: User, logger: Logger, config: Partial<UserModelConfig> = {}) {
    this.user = { ...user };
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger.child({ component: 'user-model', userId: user.id });
    this.energyProfile = { ...DEFAULT_ENERGY_PROFILE };

    // Adjust energy profile based on user patterns
    this.adjustEnergyProfile();

    this.logger.debug({ user: user.name }, 'UserModel initialized');
  }

  /**
   * Get current user state (readonly copy).
   */
  getUser(): Readonly<User> {
    return { ...this.user };
  }

  /**
   * Get estimated user energy based on time of day.
   * Returns value between 0-1.
   */
  estimateEnergy(date: Date = new Date()): number {
    const userHour = this.getUserLocalHour(date);
    const baseEnergy = this.energyProfile[userHour] ?? 0.5;

    // Confidence-weighted: less confident = closer to 0.5 (uncertain)
    const confidence = this.user.confidence;
    const uncertainEnergy = 0.5;
    const estimatedEnergy = baseEnergy * confidence + uncertainEnergy * (1 - confidence);

    return estimatedEnergy;
  }

  /**
   * Get estimated user availability.
   * Combines time-of-day with learned patterns.
   */
  estimateAvailability(date: Date = new Date()): number {
    const userHour = this.getUserLocalHour(date);
    const patterns = this.user.patterns;

    // Base availability from quiet hours
    let baseAvailability = 0.5;
    if (patterns.quietHours.includes(userHour)) {
      baseAvailability = 0.1;
    } else if (patterns.activeHours.includes(userHour)) {
      baseAvailability = 0.8;
    }

    // Energy affects availability
    const energy = this.estimateEnergy(date);
    const energyFactor = 0.3 + energy * 0.7; // Energy contributes 30-100%

    // Confidence-weighted
    const confidence = this.user.confidence;
    const uncertainAvailability = 0.5;
    const estimatedAvailability =
      baseAvailability * energyFactor * confidence + uncertainAvailability * (1 - confidence);

    return Math.min(1, Math.max(0, estimatedAvailability));
  }

  /**
   * Update beliefs based on a signal from the user.
   */
  processSignal(signal: SignalType, metadata?: Record<string, unknown>): void {
    const now = new Date();
    const oldState = { ...this.user };

    switch (signal) {
      case 'message_received':
        this.onMessageReceived(metadata);
        break;
      case 'quick_response':
        this.onQuickResponse();
        break;
      case 'slow_response':
        this.onSlowResponse();
        break;
      case 'no_response':
        this.onNoResponse();
        break;
      case 'positive_tone':
        this.onPositiveTone();
        break;
      case 'negative_tone':
        this.onNegativeTone();
        break;
      case 'explicit_busy':
        this.onExplicitBusy();
        break;
      case 'explicit_free':
        this.onExplicitFree();
        break;
      case 'explicit_tired':
        this.onExplicitTired();
        break;
      case 'explicit_energetic':
        this.onExplicitEnergetic();
        break;
      case 'message_read':
        // Minimal update - just shows they're somewhat active
        this.boostConfidence(0.1);
        break;
    }

    this.user.lastSignalAt = now;
    this.user.lastMentioned = now;

    this.logger.debug(
      {
        signal,
        before: {
          energy: oldState.energy.toFixed(2),
          availability: oldState.availability.toFixed(2),
          confidence: oldState.confidence.toFixed(2),
          mood: oldState.mood,
        },
        after: {
          energy: this.user.energy.toFixed(2),
          availability: this.user.availability.toFixed(2),
          confidence: this.user.confidence.toFixed(2),
          mood: this.user.mood,
        },
      },
      'Signal processed'
    );
  }

  /**
   * Apply time-based decay to confidence.
   * Call this periodically (e.g., on each tick).
   */
  decayConfidence(): void {
    const now = new Date();
    const hoursSinceSignal = (now.getTime() - this.user.lastSignalAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceSignal > 0) {
      const decay = this.config.confidenceDecayRate * hoursSinceSignal;
      this.user.confidence = Math.max(
        this.config.minConfidence,
        this.user.confidence - decay * 0.01 // Small decay per tick
      );
    }
  }

  /**
   * Update beliefs based on current time.
   * Call this periodically to keep energy/availability current.
   */
  updateTimeBasedBeliefs(date: Date = new Date()): void {
    // Update energy estimate
    this.user.energy = this.estimateEnergy(date);

    // Update availability estimate
    this.user.availability = this.estimateAvailability(date);

    // Apply confidence decay
    this.decayConfidence();
  }

  /**
   * Check if now is a good time to contact user.
   * Returns a score 0-1 (higher = better time).
   */
  getContactScore(date: Date = new Date()): number {
    const availability = this.estimateAvailability(date);
    const energy = this.estimateEnergy(date);
    const confidence = this.user.confidence;

    // Base score from availability and energy
    const baseScore = availability * 0.6 + energy * 0.4;

    // Confidence affects how much we trust the score
    // Low confidence = score closer to 0.5 (cautious)
    const uncertainScore = 0.4; // Slightly cautious default
    const contactScore = baseScore * confidence + uncertainScore * (1 - confidence);

    // Check quiet hours - strong penalty
    const userHour = this.getUserLocalHour(date);
    if (this.user.patterns.quietHours.includes(userHour)) {
      return contactScore * 0.3; // Heavy penalty during quiet hours
    }

    return contactScore;
  }

  /**
   * Check if user is likely asleep.
   */
  isLikelyAsleep(date: Date = new Date()): boolean {
    const userHour = this.getUserLocalHour(date);
    const patterns = this.user.patterns;

    // Check against sleep/wake patterns
    if (patterns.sleepHour !== null && patterns.wakeHour !== null) {
      if (patterns.sleepHour > patterns.wakeHour) {
        // Sleep crosses midnight (e.g., 23 to 7)
        return userHour >= patterns.sleepHour || userHour < patterns.wakeHour;
      } else {
        // Sleep doesn't cross midnight (unusual but possible)
        return userHour >= patterns.sleepHour && userHour < patterns.wakeHour;
      }
    }

    // Fallback: assume asleep 23:00 - 07:00
    return userHour >= 23 || userHour < 7;
  }

  /**
   * Update user patterns from observed behavior.
   */
  updatePatterns(updates: Partial<UserPatterns>): void {
    this.user.patterns = { ...this.user.patterns, ...updates };
    this.adjustEnergyProfile();
    this.logger.debug({ updates }, 'Patterns updated');
  }

  /**
   * Set the user's name after learning it.
   * Marks the name as known so agent won't ask again.
   */
  setName(name: string): void {
    const oldName = this.user.name;
    this.user.name = name;
    this.user.nameKnown = true;
    this.logger.info({ oldName, newName: name }, 'User name learned');
  }

  /**
   * Check if we know the user's actual name.
   */
  isNameKnown(): boolean {
    return this.user.nameKnown;
  }

  /**
   * Get the user's name (may be placeholder if not known).
   */
  getName(): string {
    return this.user.name;
  }

  /**
   * Get user beliefs for rule evaluation.
   * Returns a snapshot of key user state needed by rules.
   */
  getBeliefs(): {
    name: string;
    nameKnown: boolean;
    energy: number;
    availability: number;
    confidence: number;
  } {
    return {
      name: this.user.name,
      nameKnown: this.user.nameKnown,
      energy: this.user.energy,
      availability: this.user.availability,
      confidence: this.user.confidence,
    };
  }

  /**
   * Set the user's preferred language (detected from their messages).
   */
  setLanguage(language: string): void {
    if (this.user.preferences.language !== language) {
      this.user.preferences.language = language;
      this.logger.info({ language }, 'User language preference updated');
    }
  }

  /**
   * Get the user's preferred language (or null if not yet detected).
   */
  getLanguage(): string | null {
    return this.user.preferences.language;
  }

  /**
   * Set the user's gender (for languages with grammatical gender).
   */
  setGender(gender: 'male' | 'female' | 'unknown'): void {
    if (this.user.preferences.gender !== gender) {
      this.user.preferences.gender = gender;
      this.logger.info({ gender }, 'User gender updated');
    }
  }

  /**
   * Get the user's gender (or 'unknown' if not yet detected).
   */
  getGender(): 'male' | 'female' | 'unknown' {
    return this.user.preferences.gender;
  }

  // === Private signal handlers ===

  private onMessageReceived(metadata?: Record<string, unknown>): void {
    // User is active - boost availability and confidence
    this.user.availability = Math.min(1, this.user.availability + 0.3);
    this.boostConfidence(this.config.messageConfidenceBoost);

    // Update energy based on time
    this.user.energy = this.estimateEnergy();

    // Check for response time if provided
    if (metadata?.['responseTimeMs'] !== undefined) {
      const responseTimeSec = (metadata['responseTimeMs'] as number) / 1000;
      this.updateAvgResponseTime(responseTimeSec);
    }
  }

  private onQuickResponse(): void {
    // Quick response suggests high availability and energy
    this.user.availability = Math.min(1, this.user.availability + 0.2);
    this.user.energy = Math.min(1, this.user.energy + 0.1);
    this.boostConfidence(0.2);
    if (this.user.mood === 'unknown') {
      this.user.mood = 'neutral';
    }
  }

  private onSlowResponse(): void {
    // Slow response suggests lower availability
    this.user.availability = Math.max(0, this.user.availability - 0.1);
    this.boostConfidence(0.1);
  }

  private onNoResponse(): void {
    // No response - decrease availability, slight confidence boost (we learned something)
    this.user.availability = Math.max(0, this.user.availability - 0.3);
    this.boostConfidence(0.05);
  }

  private onPositiveTone(): void {
    this.user.mood = 'positive';
    this.user.energy = Math.min(1, this.user.energy + 0.1);
    this.boostConfidence(0.15);
  }

  private onNegativeTone(): void {
    this.user.mood = 'negative';
    this.boostConfidence(0.15);
  }

  private onExplicitBusy(): void {
    this.user.availability = 0.1;
    this.boostConfidence(this.config.explicitSignalBoost);
  }

  private onExplicitFree(): void {
    this.user.availability = 0.9;
    this.boostConfidence(this.config.explicitSignalBoost);
  }

  private onExplicitTired(): void {
    this.user.mood = 'tired';
    this.user.energy = 0.2;
    this.user.availability = Math.max(0, this.user.availability - 0.2);
    this.boostConfidence(this.config.explicitSignalBoost);
  }

  private onExplicitEnergetic(): void {
    this.user.mood = 'positive';
    this.user.energy = 0.9;
    this.boostConfidence(this.config.explicitSignalBoost);
  }

  // === Private helpers ===

  private boostConfidence(amount: number): void {
    this.user.confidence = Math.min(this.config.maxConfidence, this.user.confidence + amount);
  }

  private getUserLocalHour(date: Date): number {
    const utcHour = date.getUTCHours();
    let localHour = utcHour + this.user.timezoneOffset;
    if (localHour < 0) localHour += 24;
    if (localHour >= 24) localHour -= 24;
    return Math.floor(localHour);
  }

  private adjustEnergyProfile(): void {
    const patterns = this.user.patterns;

    // Adjust based on wake/sleep times
    if (patterns.wakeHour !== null) {
      // Lower energy before wake hour
      for (let h = 0; h < patterns.wakeHour; h++) {
        this.energyProfile[h] = Math.min(this.energyProfile[h] ?? 0.5, 0.2);
      }
      // Ramp up around wake hour
      this.energyProfile[patterns.wakeHour] = 0.4;
      const hourAfterWake = (patterns.wakeHour + 1) % 24;
      this.energyProfile[hourAfterWake] = 0.6;
    }

    if (patterns.sleepHour !== null) {
      // Lower energy after sleep hour
      this.energyProfile[patterns.sleepHour] = 0.2;
      const hourAfterSleep = (patterns.sleepHour + 1) % 24;
      this.energyProfile[hourAfterSleep] = 0.1;
    }
  }

  private updateAvgResponseTime(responseTimeSec: number): void {
    const current = this.user.patterns.avgResponseTime;
    if (current === null) {
      this.user.patterns.avgResponseTime = responseTimeSec;
    } else {
      // Exponential moving average
      this.user.patterns.avgResponseTime = current * 0.8 + responseTimeSec * 0.2;
    }
  }
}

/**
 * Factory function for creating a user model.
 */
export function createUserModel(
  user: User,
  logger: Logger,
  config?: Partial<UserModelConfig>
): UserModel {
  return new UserModel(user, logger, config);
}

/**
 * Factory function for creating a new user with a model.
 */
export function createNewUserWithModel(
  id: string,
  name: string,
  logger: Logger,
  timezoneOffset = 0,
  config?: Partial<UserModelConfig>
): UserModel {
  const user = createUser(id, name, timezoneOffset);
  return new UserModel(user, logger, config);
}
