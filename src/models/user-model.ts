import {
  round3,
  type Logger,
  updateNumericBelief,
  createBelief,
  decayBelief,
} from '../types/index.js';
import type { User, UserPatterns, UserMood } from '../types/user/user.js';
import { createUser } from '../types/user/user.js';
import { isNameKnown as checkNameKnown } from '../types/user/person.js';

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
  private lastDecayAt: Date;
  private lastAvailabilitySignalAt: Date | null = null;
  private lastAvailabilityDriftAt: Date;

  /**
   * Per-chat timezone overrides (IANA timezone names).
   * Used by plugins for DST-aware scheduling.
   */
  private chatTimezones = new Map<string, string>();

  /**
   * Default timezone (IANA name) for the user.
   * Derived from timezoneOffset if not explicitly set.
   */
  private defaultTimezone: string | null = null;

  constructor(user: User, logger: Logger, config: Partial<UserModelConfig> = {}) {
    this.user = { ...user };
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.logger = logger.child({ component: 'user-model', userId: user.id });
    this.energyProfile = { ...DEFAULT_ENERGY_PROFILE };
    this.lastDecayAt = new Date();
    // Signal timestamp not persisted - no grace period after restart
    // (we don't know if last update was signal-based or drift-based)
    this.lastAvailabilitySignalAt = null;
    // Initialize drift timestamp from persisted state for continuity
    this.lastAvailabilityDriftAt = user.beliefs.availability.updatedAt;

    // Restore chat timezones from persisted state
    if (user.chatTimezones) {
      this.restoreChatTimezones(user.chatTimezones);
    }
    if (user.defaultTimezone) {
      this.defaultTimezone = user.defaultTimezone;
    }

    // Adjust energy profile based on user patterns
    this.adjustEnergyProfile();

    this.logger.debug({ user: user.name }, 'UserModel initialized');
  }

  /**
   * Get current user state (readonly copy).
   * Includes chatTimezones and defaultTimezone for persistence.
   */
  getUser(): Readonly<User> {
    const user = { ...this.user };
    // Include timezone overrides for persistence
    if (this.chatTimezones.size > 0) {
      user.chatTimezones = Object.fromEntries(this.chatTimezones);
    }
    if (this.defaultTimezone) {
      user.defaultTimezone = this.defaultTimezone;
    }
    return user;
  }

  /**
   * Get estimated user energy based on time of day.
   * Returns value between 0-1.
   */
  estimateEnergy(date: Date = new Date()): number {
    const userHour = this.getUserLocalHour(date);
    const baseEnergy = this.energyProfile[userHour] ?? 0.5;

    // Confidence-weighted: less confident = closer to 0.5 (uncertain)
    const confidence = this.user.beliefs.energy.confidence;
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
    const confidence = this.user.beliefs.availability.confidence;
    const uncertainAvailability = 0.5;
    const estimatedAvailability =
      baseAvailability * energyFactor * confidence + uncertainAvailability * (1 - confidence);

    return Math.min(1, Math.max(0, estimatedAvailability));
  }

  /**
   * Get average confidence across all beliefs.
   */
  getAverageConfidence(): number {
    const beliefs = this.user.beliefs;
    return (
      (beliefs.energy.confidence + beliefs.mood.confidence + beliefs.availability.confidence) / 3
    );
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
        this.setAvailability(this.user.beliefs.availability.value + 0.05, 0.4);
        break;
    }

    this.user.lastMentioned = now;

    this.logger.debug(
      {
        signal,
        before: {
          energy: oldState.beliefs.energy.value.toFixed(2),
          availability: oldState.beliefs.availability.value.toFixed(2),
          confidence: this.getAverageConfidence().toFixed(2),
          mood: oldState.beliefs.mood.value,
        },
        after: {
          energy: this.user.beliefs.energy.value.toFixed(2),
          availability: this.user.beliefs.availability.value.toFixed(2),
          confidence: this.getAverageConfidence().toFixed(2),
          mood: this.user.beliefs.mood.value,
        },
      },
      'Signal processed'
    );
  }

  /**
   * Apply time-based decay to all belief confidences.
   * Call this periodically (e.g., on each tick).
   * Uses actual elapsed time since last decay call.
   */
  decayConfidence(): void {
    const now = new Date();
    const elapsedMs = now.getTime() - this.lastDecayAt.getTime();
    this.lastDecayAt = now;

    // Skip if called too frequently (< 1 second)
    if (elapsedMs < 1000) return;

    const halfLifeMs = 3600000; // 1 hour half-life

    this.user.beliefs.energy = decayBelief(
      this.user.beliefs.energy,
      elapsedMs,
      halfLifeMs,
      this.config.minConfidence
    );
    this.user.beliefs.mood = decayBelief(
      this.user.beliefs.mood,
      elapsedMs,
      halfLifeMs,
      this.config.minConfidence
    );
    this.user.beliefs.availability = decayBelief(
      this.user.beliefs.availability,
      elapsedMs,
      halfLifeMs,
      this.config.minConfidence
    );
  }

  /**
   * Update beliefs based on current time.
   * Call this periodically to keep energy/availability current.
   *
   * Time-based and event-based signals are merged, not overridden:
   * - Time estimate provides the baseline (where availability drifts toward)
   * - Event signals shift the value from baseline
   * - Value gradually blends back toward time estimate over time
   * - Time drift only nudges value, preserves signal metadata (source, evidence)
   */
  updateTimeBasedBeliefs(date: Date = new Date()): void {
    // Update energy estimate (follows circadian rhythm)
    this.setEnergy(this.estimateEnergy(date));

    // Drift availability toward time-based estimate
    this.driftAvailabilityTowardEstimate(date);

    // Apply confidence decay
    this.decayConfidence();
  }

  /**
   * Drift availability toward time estimate without overwriting signal metadata.
   * Uses half-life formula for time-independent decay.
   * Updates value and updatedAt, preserves source/evidenceCount.
   */
  private driftAvailabilityTowardEstimate(date: Date): void {
    // Grace period: don't drift for 30 seconds after a signal
    const gracePeriodMs = 30_000;
    if (this.lastAvailabilitySignalAt) {
      const timeSinceSignal = date.getTime() - this.lastAvailabilitySignalAt.getTime();
      if (timeSinceSignal < gracePeriodMs) {
        return;
      }
    }

    const timeEstimate = this.estimateAvailability(date);
    const currentValue = this.user.beliefs.availability.value;
    const diff = timeEstimate - currentValue;

    // Skip if already close enough
    if (Math.abs(diff) < 0.01) {
      return;
    }

    // Time-scaled drift using half-life formula
    // Half-life of 5 minutes = value moves halfway to target in 5 min
    const halfLifeMs = 5 * 60 * 1000;
    const elapsedMs = Math.max(0, date.getTime() - this.lastAvailabilityDriftAt.getTime());
    const decayFactor = Math.pow(0.5, elapsedMs / halfLifeMs);
    const driftedValue = timeEstimate - diff * decayFactor;

    // Update value and updatedAt, preserve source/evidenceCount
    // Use passed date for consistency (allows simulations/tests to work correctly)
    this.user.beliefs.availability = {
      ...this.user.beliefs.availability,
      value: round3(Math.max(0, Math.min(1, driftedValue))),
      updatedAt: date,
    };

    this.lastAvailabilityDriftAt = date;
  }

  /**
   * Check if now is a good time to contact user.
   * Returns a score 0-1 (higher = better time).
   */
  getContactScore(date: Date = new Date()): number {
    const availability = this.estimateAvailability(date);
    const energy = this.estimateEnergy(date);
    const confidence = this.getAverageConfidence();

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
   */
  setName(name: string): void {
    const oldName = this.user.name;
    this.user.name = name;
    this.logger.info({ oldName, newName: name }, 'User name learned');
  }

  /**
   * Check if we know the user's actual name.
   */
  isNameKnown(): boolean {
    return checkNameKnown(this.user);
  }

  /**
   * Get the user's name (null if not known).
   */
  getName(): string | null {
    return this.user.name;
  }

  /**
   * Get user beliefs for rule evaluation.
   * Returns a snapshot of key user state needed by rules.
   */
  getBeliefs(): {
    name: string | null;
    energy: number;
    availability: number;
    confidence: number;
  } {
    return {
      name: this.user.name,
      energy: this.user.beliefs.energy.value,
      availability: this.user.beliefs.availability.value,
      confidence: this.getAverageConfidence(),
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

  /**
   * Set the user's mood.
   */
  setMood(mood: UserMood): void {
    if (this.user.beliefs.mood.value !== mood) {
      this.user.beliefs.mood = createBelief(mood, 0.8, 'explicit');
      this.logger.debug({ mood }, 'User mood updated');
    }
  }

  /**
   * Update the user's energy level (0-1).
   */
  updateEnergy(value: number): void {
    this.setEnergy(value);
  }

  /**
   * Update the user's availability (0-1).
   */
  updateAvailability(value: number): void {
    this.setAvailability(value);
  }

  /**
   * Set the user's timezone offset.
   */
  setTimezone(offset: number): void {
    if (this.user.timezoneOffset !== offset) {
      this.user.timezoneOffset = offset;
      this.adjustEnergyProfile();
      this.logger.info({ offset }, 'User timezone updated');
    }
  }

  /**
   * Get the user's timezone (IANA name) for a specific chat.
   *
   * Resolution order:
   * 1. Per-chat override (chatTimezones map)
   * 2. Default timezone (if set explicitly)
   * 3. Derive from timezoneOffset (approximate)
   * 4. Return null (unknown - caller should ask user)
   *
   * @param chatId Optional chat ID for per-chat override
   */
  getTimezone(chatId?: string): string | null {
    // 1. Per-chat override
    if (chatId) {
      const chatTz = this.chatTimezones.get(chatId);
      if (chatTz) return chatTz;
    }

    // 2. Default timezone
    if (this.defaultTimezone) return this.defaultTimezone;

    // 3. Derive from offset (approximate - no DST awareness)
    if (this.user.timezoneOffset !== null) {
      // This is a rough approximation - use Etc/GMT timezones
      // Note: Etc/GMT signs are inverted from what you might expect
      const invertedOffset = -this.user.timezoneOffset;
      const sign = invertedOffset >= 0 ? '+' : '';
      return `Etc/GMT${sign}${String(invertedOffset)}`;
    }

    // 4. Unknown
    return null;
  }

  /**
   * Set the timezone for a specific chat (IANA timezone name).
   * Used when user explicitly specifies timezone in a message.
   */
  setChatTimezone(chatId: string, timezone: string): void {
    this.chatTimezones.set(chatId, timezone);
    this.logger.info({ chatId, timezone }, 'Chat timezone set');
  }

  /**
   * Set the default timezone (IANA name).
   * Takes precedence over derived timezone from offset.
   */
  setDefaultTimezone(timezone: string): void {
    this.defaultTimezone = timezone;
    this.logger.info({ timezone }, 'Default timezone set');
  }

  /**
   * Get all chat timezones (for persistence).
   */
  getChatTimezones(): Map<string, string> {
    return new Map(this.chatTimezones);
  }

  /**
   * Restore chat timezones (from persistence).
   */
  restoreChatTimezones(timezones: Map<string, string> | Record<string, string>): void {
    this.chatTimezones.clear();
    const entries = timezones instanceof Map ? timezones.entries() : Object.entries(timezones);
    for (const [chatId, tz] of entries) {
      this.chatTimezones.set(chatId, tz);
    }
  }

  // === Private signal handlers ===

  private onMessageReceived(metadata?: Record<string, unknown>): void {
    // User is active - boost availability
    this.setAvailability(this.user.beliefs.availability.value + 0.3, 0.7);

    // Update energy based on time
    this.setEnergy(this.estimateEnergy(), 0.6);

    // Check for response time if provided
    if (metadata?.['responseTimeMs'] !== undefined) {
      const responseTimeSec = (metadata['responseTimeMs'] as number) / 1000;
      this.updateAvgResponseTime(responseTimeSec);
    }
  }

  private onQuickResponse(): void {
    // Quick response suggests high availability and energy
    this.setAvailability(this.user.beliefs.availability.value + 0.2, 0.7);
    this.setEnergy(this.user.beliefs.energy.value + 0.1, 0.7);
    if (this.user.beliefs.mood.value === 'unknown') {
      this.user.beliefs.mood = createBelief<UserMood>('neutral', 0.5, 'inferred');
    }
  }

  private onSlowResponse(): void {
    // Slow response suggests lower availability
    this.setAvailability(this.user.beliefs.availability.value - 0.1, 0.6);
  }

  private onNoResponse(): void {
    // No response - decrease availability
    this.setAvailability(this.user.beliefs.availability.value - 0.3, 0.5);
  }

  private onPositiveTone(): void {
    this.user.beliefs.mood = createBelief<UserMood>('positive', 0.8, 'inferred');
    this.setEnergy(this.user.beliefs.energy.value + 0.1, 0.7);
  }

  private onNegativeTone(): void {
    this.user.beliefs.mood = createBelief<UserMood>('negative', 0.8, 'inferred');
  }

  private onExplicitBusy(): void {
    this.setAvailability(0.1, 0.95);
  }

  private onExplicitFree(): void {
    this.setAvailability(0.9, 0.95);
  }

  private onExplicitTired(): void {
    this.user.beliefs.mood = createBelief<UserMood>('tired', 0.95, 'explicit');
    this.setEnergy(0.2, 0.95);
    this.setAvailability(this.user.beliefs.availability.value - 0.2, 0.8);
  }

  private onExplicitEnergetic(): void {
    this.user.beliefs.mood = createBelief<UserMood>('positive', 0.95, 'explicit');
    this.setEnergy(0.9, 0.95);
  }

  // === Private setters (update beliefs with confidence) ===

  private setEnergy(value: number, confidence = 0.6): void {
    const clampedValue = round3(Math.max(0, Math.min(1, value)));
    this.user.beliefs.energy = updateNumericBelief(
      this.user.beliefs.energy,
      clampedValue,
      confidence,
      'inferred'
    );
  }

  private setAvailability(value: number, confidence = 0.6, fromSignal = true): void {
    const clampedValue = round3(Math.max(0, Math.min(1, value)));
    this.user.beliefs.availability = updateNumericBelief(
      this.user.beliefs.availability,
      clampedValue,
      confidence,
      'inferred'
    );
    if (fromSignal) {
      this.lastAvailabilitySignalAt = new Date();
    }
  }

  private getUserLocalHour(date: Date): number {
    // If timezone unknown, use system local time as fallback
    if (this.user.timezoneOffset === null) {
      return date.getHours();
    }
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
  name: string | null,
  logger: Logger,
  timezoneOffset: number | null = null,
  config?: Partial<UserModelConfig>
): UserModel {
  const user = createUser(id, name, timezoneOffset);
  return new UserModel(user, logger, config);
}
