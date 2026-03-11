import { round3, type Logger, type EventQueue, type Metrics, type Intent } from '../types/index.js';
import type { AgentState, AlertnessMode, SleepState } from '../types/agent/state.js';
import type { AgentIdentity } from '../types/agent/identity.js';
import { createDefaultAgentState, createDefaultSleepState } from '../types/agent/state.js';
import { createDefaultIdentity } from '../types/agent/identity.js';
import { type EnergyModel, createEnergyModel } from './energy.js';
import { getEffectiveTimezone, isWithinSleepWindow } from '../utils/date.js';

/**
 * Agent dependencies injected via constructor.
 */
export interface AgentDependencies {
  logger: Logger;
  eventQueue?: EventQueue | undefined;
  metrics: Metrics;
}

/**
 * Agent configuration.
 */
export interface AgentConfig {
  /** Initial state (optional, uses defaults if not provided) */
  initialState?: Partial<AgentState>;

  /** Initial sleep state (optional, uses defaults if not provided) */
  initialSleepState?: Partial<SleepState>;

  /** Agent identity (optional, uses defaults if not provided) */
  identity?: AgentIdentity;

  /** User's sleep schedule for clock-driven sleep mode */
  sleepSchedule?: { sleepHour: number; wakeHour: number } | undefined;

  /** Social debt accumulation rate per tick (default: 0.005) */
  socialDebtRate?: number;

  /** Curiosity decay rate toward 0.5 baseline per hour (default: 0.01) */
  curiosityDecayRatePerHour?: number;

  /** User's timezone for time-of-day calculations (IANA name or UTC offset).
   *  Falls back to 'Europe/Moscow' if not set. */
  timezone?: string | undefined;
}

/**
 * The Agent - a human-like proactive AI entity.
 *
 * Unlike a chatbot that responds on command, the Agent has:
 * - Internal state (energy, social debt, pressure)
 * - Identity (personality traits, values, boundaries)
 * - Clock-driven sleep/wake cycle
 *
 * The Agent receives dependencies via constructor (manual DI)
 * and does not directly mutate external state - it returns Intents.
 */
export class Agent {
  private readonly logger: Logger;
  private readonly eventQueue: EventQueue | undefined;
  private readonly metrics: Metrics;

  private state: AgentState;
  private sleepState: SleepState;
  private readonly identity: AgentIdentity;
  private readonly energy: EnergyModel;
  private readonly config: {
    initialState: AgentState;
    initialSleepState: SleepState;
    identity: AgentIdentity;
    sleepSchedule: { sleepHour: number; wakeHour: number };
    socialDebtRate: number;
    curiosityDecayRatePerHour: number;
    timezone: string | undefined;
  };
  private forcedAwakeUntil: Date | null = null;

  constructor(dependencies: AgentDependencies, config: AgentConfig = {}) {
    this.logger = dependencies.logger.child({ component: 'agent' });
    this.eventQueue = dependencies.eventQueue;
    this.metrics = dependencies.metrics;

    // Initialize state
    const defaultState = createDefaultAgentState();
    this.state = {
      ...defaultState,
      ...config.initialState,
    };

    // Initialize sleep state
    const defaultSleepState = createDefaultSleepState();
    this.sleepState = {
      ...defaultSleepState,
      ...config.initialSleepState,
    };
    this.identity = config.identity ?? createDefaultIdentity();

    const sleepSchedule = config.sleepSchedule ?? { sleepHour: 23, wakeHour: 8 };

    // Create energy model with resolved timezone (same fallback as updateSleepMode)
    const resolvedTimezone = getEffectiveTimezone(config.timezone);
    this.energy = createEnergyModel(this.state.energy, this.logger, {
      timezone: resolvedTimezone,
      sleepHour: sleepSchedule.sleepHour,
      wakeHour: sleepSchedule.wakeHour,
    });

    // Store config with defaults
    this.config = {
      initialState: this.state,
      initialSleepState: this.sleepState,
      identity: this.identity,
      sleepSchedule,
      socialDebtRate: config.socialDebtRate ?? 0.005, // Increased from 0.001 for faster accumulation
      curiosityDecayRatePerHour: config.curiosityDecayRatePerHour ?? 0.01, // Decay toward 0.5 baseline
      timezone: config.timezone,
    };

    this.logger.info({ name: this.identity.name, energy: this.state.energy }, 'Agent initialized');
  }

  /**
   * Get agent's name.
   */
  getName(): string {
    return this.identity.name;
  }

  /**
   * Get current agent state (readonly copy).
   */
  getState(): Readonly<AgentState> {
    return { ...this.state };
  }

  /**
   * Get current sleep state (readonly copy).
   */
  getSleepState(): Readonly<SleepState> {
    return { ...this.sleepState };
  }

  /**
   * Get agent identity (readonly).
   */
  getIdentity(): Readonly<AgentIdentity> {
    return this.identity;
  }

  /**
   * Get the event queue (for use by event loop - optional in 4-layer architecture).
   */
  getEventQueue(): EventQueue | undefined {
    return this.eventQueue;
  }

  /**
   * Get current energy level.
   */
  getEnergy(): number {
    return this.energy.getEnergy();
  }

  /**
   * Get current alertness mode.
   */
  getAlertnessMode(): AlertnessMode {
    return this.sleepState.mode;
  }

  /**
   * Process a tick - the agent's heartbeat.
   *
   * Called periodically (dynamic interval). Updates internal state,
   * accumulates pressures, and returns intents for any actions needed.
   *
   * @returns Array of intents to be processed by the core
   */
  tick(): Intent[] {
    const intents: Intent[] = [];
    const now = new Date();

    // Drain energy for tick
    this.energy.drain('tick');

    // Recharge based on time of day
    this.energy.tickRecharge();

    // Sync energy to state
    this.state.energy = this.energy.getEnergy();

    // Accumulate social debt
    this.setStateValue('socialDebt', this.state.socialDebt + this.config.socialDebtRate);

    // Decay curiosity toward 0.5 baseline (slow return to equilibrium)
    const curiosityBaseline = 0.5;
    if (this.state.curiosity !== curiosityBaseline) {
      // Calculate decay based on actual elapsed time since last tick
      const elapsedMs = Math.min(
        5000,
        Math.max(1, now.getTime() - this.state.lastTickAt.getTime())
      );
      const decayPerTick = this.config.curiosityDecayRatePerHour * (elapsedMs / 3_600_000);

      if (this.state.curiosity > curiosityBaseline) {
        // Decay downward toward baseline
        const newCuriosity = Math.max(curiosityBaseline, this.state.curiosity - decayPerTick);
        this.state.curiosity = round3(newCuriosity);
      } else {
        // Increase upward toward baseline
        const newCuriosity = Math.min(curiosityBaseline, this.state.curiosity + decayPerTick);
        this.state.curiosity = round3(newCuriosity);
      }
    }

    // Update sleep mode based on clock
    this.updateSleepMode();
    this.state.lastTickAt = now;

    // Log state periodically (every 10th tick or on mode change)
    this.logger.trace(
      {
        energy: this.state.energy.toFixed(3),
        socialDebt: this.state.socialDebt.toFixed(3),
        mode: this.sleepState.mode,
      },
      'Tick completed'
    );

    // Emit metrics
    this.metrics.gauge('agent_energy', this.state.energy);
    this.metrics.gauge('agent_social_debt', this.state.socialDebt);
    this.metrics.gauge('agent_task_pressure', this.state.taskPressure);
    this.metrics.counter('agent_ticks');

    return intents;
  }

  /**
   * Apply an intent that affects agent state.
   *
   * Called by the core after collecting intents from all sources.
   */
  applyIntent(intent: Intent): void {
    if (intent.type === 'UPDATE_STATE') {
      const { key, value, delta } = intent.payload;
      if (!(key in this.state)) {
        return;
      }

      // Type-safe update for numeric state fields (0-1 clamped)
      if (this.isNumericStateKey(key) && typeof value === 'number') {
        if (delta) {
          const currentValue = this.state[key];
          this.state[key] = round3(Math.max(0, Math.min(1, currentValue + value)));
        } else {
          this.state[key] = round3(Math.max(0, Math.min(1, value)));
        }

        // Special handling: sync energy state to energy model
        if (key === 'energy') {
          this.energy.setEnergy(this.state.energy);
        }

        this.logger.trace({ key, value, delta }, 'State updated via intent');
        return;
      }

      // Non-numeric fields (acquaintancePending, lastTickAt)
      // These are rarely updated via intents, handle explicitly if needed
      this.logger.trace({ key, value }, 'Non-numeric state update ignored');
    }
  }

  /**
   * Type guard for numeric state fields that can be updated via intents.
   */
  private isNumericStateKey(
    key: string
  ): key is
    | 'energy'
    | 'socialDebt'
    | 'taskPressure'
    | 'curiosity'
    | 'acquaintancePressure'
    | 'thoughtPressure'
    | 'desirePressure' {
    return [
      'energy',
      'socialDebt',
      'taskPressure',
      'curiosity',
      'acquaintancePressure',
      'thoughtPressure',
      'desirePressure',
    ].includes(key);
  }

  /**
   * Notify agent of an event being processed (drains energy).
   */
  onEventProcessed(): void {
    this.energy.drain('event');
    this.state.energy = this.energy.getEnergy();
  }

  /**
   * Notify agent of an LLM call (drains energy).
   */
  onLLMCall(): void {
    this.energy.drain('llm');
    this.state.energy = this.energy.getEnergy();
  }

  /**
   * Notify agent of a message sent (drains energy, relieves social pressure).
   * Called when the agent proactively reaches out or responds.
   */
  onMessageSent(): void {
    this.energy.drain('message');
    this.state.energy = this.energy.getEnergy();

    // Sending a message relieves the overall urge to contact.
    // Like a human who calls their mom — the guilt, the "I should say something",
    // and the curiosity are all relieved by the act of reaching out.
    this.setStateValue('socialDebt', this.state.socialDebt - 0.4);
    this.setStateValue('taskPressure', this.state.taskPressure * 0.3);
    this.setStateValue('curiosity', this.state.curiosity * 0.3);
    this.setStateValue('desirePressure', this.state.desirePressure * 0.5);

    this.logger.debug('Message sent - contact pressure relieved');
  }

  /**
   * Notify agent of positive user feedback (recharges energy).
   */
  onPositiveFeedback(): void {
    this.energy.recharge('positive_feedback');
    this.state.energy = this.energy.getEnergy();

    // Also reduce social debt
    this.setStateValue('socialDebt', this.state.socialDebt - 0.1);

    this.logger.debug('Received positive feedback');
  }

  /**
   * Add disturbance during sleep mode (from filtered events).
   *
   * @returns true if the disturbance woke the agent
   */
  addDisturbance(amount: number): boolean {
    if (this.sleepState.mode !== 'sleeping') {
      return false;
    }

    this.sleepState.disturbance = Math.min(1, this.sleepState.disturbance + amount);
    const threshold = this.energy.calculateWakeThreshold(this.sleepState.wakeThreshold);

    if (this.sleepState.disturbance > threshold) {
      this.logger.info(
        { disturbance: this.sleepState.disturbance, threshold },
        'Agent woken by accumulated disturbance'
      );
      this.sleepState.mode = 'awake';
      this.sleepState.disturbance = 0;
      this.forcedAwakeUntil = new Date(Date.now() + 5 * 60 * 1000); // 5min grace
      return true;
    }

    return false;
  }

  /**
   * Force wake the agent (e.g., for CRITICAL events).
   */
  wake(): void {
    if (this.sleepState.mode === 'sleeping') {
      this.logger.info('Agent force-woken');
      this.sleepState.mode = 'awake';
      this.sleepState.disturbance = 0;
      this.forcedAwakeUntil = new Date(Date.now() + 5 * 60 * 1000); // 5min grace
    }
  }

  /**
   * Calculate the combined "reach out" pressure.
   *
   * This is a neuron-like weighted sum of state variables.
   * When this crosses a threshold, the agent considers contacting the user.
   */
  calculateReachOutPressure(): number {
    // Weights from personality
    const socialDebtWeight = 1 - this.identity.personality.shyness;
    const taskPressureWeight = this.identity.personality.independence;
    const curiosityWeight = this.identity.personality.curiosity;

    // Weighted sum
    const pressure =
      this.state.socialDebt * socialDebtWeight * 0.4 +
      this.state.taskPressure * taskPressureWeight * 0.4 +
      this.state.curiosity * curiosityWeight * 0.2;

    // Energy modulates willingness to act
    const energyMultiplier = 0.5 + this.state.energy * 0.5;

    return pressure * energyMultiplier;
  }

  /**
   * Update sleep mode based on clock (user's sleep schedule).
   */
  private updateSleepMode(): void {
    const tz = getEffectiveTimezone(this.config.timezone);
    const localHourStr = new Date().toLocaleString('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: tz,
    });
    const hour = parseInt(localHourStr, 10);
    const { sleepHour, wakeHour } = this.config.sleepSchedule;
    const shouldSleep = isWithinSleepWindow(hour, sleepHour, wakeHour);

    if (shouldSleep && this.sleepState.mode === 'awake') {
      // Check wake grace period (prevents flapping after disturbance wake)
      if (this.forcedAwakeUntil && new Date() < this.forcedAwakeUntil) {
        return;
      }
      this.logger.info({ hour, sleepHour, wakeHour }, 'Entering sleep mode (clock-driven)');
      this.sleepState.mode = 'sleeping';
      this.forcedAwakeUntil = null;
    } else if (!shouldSleep && this.sleepState.mode === 'sleeping') {
      this.logger.info({ hour, sleepHour, wakeHour }, 'Waking up (clock-driven)');
      this.sleepState.mode = 'awake';
      this.sleepState.disturbance = 0;
      this.forcedAwakeUntil = null;
    }

    // Decay disturbance while sleeping
    if (this.sleepState.mode === 'sleeping') {
      this.sleepState.disturbance *= this.sleepState.disturbanceDecay;
    }
  }

  /**
   * Set a numeric state value with rounding and clamping.
   */
  private setStateValue(
    key: 'socialDebt' | 'taskPressure' | 'curiosity' | 'desirePressure',
    value: number
  ): void {
    this.state[key] = round3(Math.max(0, Math.min(1, value)));
  }

  /**
   * Update specific state fields.
   * Used by CoreLoop to set thought pressure before neurons run.
   */
  updateState(
    updates: Partial<Pick<AgentState, 'thoughtPressure' | 'pendingThoughtCount' | 'desirePressure'>>
  ): void {
    if (updates.thoughtPressure !== undefined) {
      this.state.thoughtPressure = round3(Math.max(0, Math.min(1, updates.thoughtPressure)));
    }
    if (updates.pendingThoughtCount !== undefined) {
      this.state.pendingThoughtCount = Math.max(0, Math.floor(updates.pendingThoughtCount));
    }
    if (updates.desirePressure !== undefined) {
      this.state.desirePressure = round3(Math.max(0, Math.min(1, updates.desirePressure)));
    }
  }

  /**
   * Get the energy model for energy operations.
   */
  getEnergyModel(): EnergyModel {
    return this.energy;
  }
}

/**
 * Factory function for creating an agent.
 */
export function createAgent(dependencies: AgentDependencies, config?: AgentConfig): Agent {
  return new Agent(dependencies, config);
}
