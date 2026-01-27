import type { Logger, EventQueue, Metrics, Intent } from '../types/index.js';
import type { AgentState, AlertnessMode, SleepState } from '../types/agent/state.js';
import type { AgentIdentity } from '../types/agent/identity.js';
import { createDefaultAgentState, createDefaultSleepState } from '../types/agent/state.js';
import { createDefaultIdentity } from '../types/agent/identity.js';
import { type EnergyModel, createEnergyModel } from './energy.js';

/**
 * Agent dependencies injected via constructor.
 */
export interface AgentDependencies {
  logger: Logger;
  eventQueue: EventQueue;
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

  /** Tick rate configuration */
  tickRate?: {
    /** Minimum tick interval in ms (default: 1000 = 1s) */
    min: number;
    /** Maximum tick interval in ms (default: 60000 = 1min) */
    max: number;
    /** Base interval in ms (default: 30000 = 30s) */
    base: number;
  };

  /** Social debt accumulation rate per tick (default: 0.001) */
  socialDebtRate?: number;
}

const DEFAULT_TICK_RATE = {
  min: 1_000, // 1 second minimum
  max: 60_000, // 1 minute maximum
  base: 30_000, // 30 seconds base
};

/**
 * The Agent - a human-like proactive AI entity.
 *
 * Unlike a chatbot that responds on command, the Agent has:
 * - Internal state (energy, social debt, pressure)
 * - Identity (personality traits, values, boundaries)
 * - Dynamic behavior (tick rate adapts to state)
 *
 * The Agent receives dependencies via constructor (manual DI)
 * and does not directly mutate external state - it returns Intents.
 */
export class Agent {
  private readonly logger: Logger;
  private readonly eventQueue: EventQueue;
  private readonly metrics: Metrics;

  private state: AgentState;
  private sleepState: SleepState;
  private readonly identity: AgentIdentity;
  private readonly energy: EnergyModel;
  private readonly config: Required<AgentConfig>;

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

    // Create energy model
    this.energy = createEnergyModel(this.state.energy, this.logger);

    // Store config with defaults
    this.config = {
      initialState: this.state,
      initialSleepState: this.sleepState,
      identity: this.identity,
      tickRate: config.tickRate ?? DEFAULT_TICK_RATE,
      socialDebtRate: config.socialDebtRate ?? 0.001,
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
   * Get the event queue (for use by event loop in Phase 5).
   */
  getEventQueue(): EventQueue {
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
    this.state.socialDebt = Math.min(1, this.state.socialDebt + this.config.socialDebtRate);

    // Update alertness mode based on state
    this.updateAlertnessMode();

    // Calculate next tick interval
    this.state.tickInterval = this.calculateNextTickInterval();
    this.state.lastTickAt = now;

    // Log state periodically (every 10th tick or on mode change)
    this.logger.debug(
      {
        energy: this.state.energy.toFixed(3),
        socialDebt: this.state.socialDebt.toFixed(3),
        mode: this.sleepState.mode,
        nextTick: this.state.tickInterval,
      },
      'Tick completed'
    );

    // Emit metrics
    this.metrics.gauge('agent_energy', this.state.energy);
    this.metrics.gauge('agent_social_debt', this.state.socialDebt);
    this.metrics.gauge('agent_task_pressure', this.state.taskPressure);
    this.metrics.gauge('agent_tick_interval', this.state.tickInterval);
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
      if (key in this.state) {
        const stateKey = key as keyof AgentState;
        if (delta && typeof value === 'number') {
          const currentValue = this.state[stateKey];
          if (typeof currentValue === 'number') {
            // @ts-expect-error - we've validated the types
            this.state[stateKey] = Math.max(0, Math.min(1, currentValue + value));
          }
        } else {
          // @ts-expect-error - dynamic state update
          this.state[stateKey] = value;
        }

        // Special handling: sync energy state to energy model
        if (key === 'energy' && typeof value === 'number') {
          this.energy.setEnergy(value);
        }

        this.logger.debug({ key, value, delta }, 'State updated via intent');
      }
    }
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
   * Notify agent of a message sent (drains energy).
   */
  onMessageSent(): void {
    this.energy.drain('message');
    this.state.energy = this.energy.getEnergy();
  }

  /**
   * Notify agent of positive user feedback (recharges energy).
   */
  onPositiveFeedback(): void {
    this.energy.recharge('positive_feedback');
    this.state.energy = this.energy.getEnergy();

    // Also reduce social debt
    this.state.socialDebt = Math.max(0, this.state.socialDebt - 0.1);

    this.logger.debug('Received positive feedback');
  }

  /**
   * Add disturbance during sleep mode (from filtered events).
   *
   * @returns true if the disturbance woke the agent
   */
  addDisturbance(amount: number): boolean {
    if (this.sleepState.mode !== 'sleep' && this.sleepState.mode !== 'relaxed') {
      return false;
    }

    this.sleepState.disturbance = Math.min(1, this.sleepState.disturbance + amount);

    const threshold = this.energy.calculateWakeThreshold(this.sleepState.wakeThreshold);

    if (this.sleepState.disturbance > threshold) {
      this.logger.info(
        {
          disturbance: this.sleepState.disturbance,
          threshold,
        },
        'Agent woken by accumulated disturbance'
      );
      this.sleepState.mode = 'normal';
      this.sleepState.disturbance = 0;
      return true;
    }

    return false;
  }

  /**
   * Force wake the agent (e.g., for CRITICAL events).
   */
  wake(): void {
    if (this.sleepState.mode === 'sleep' || this.sleepState.mode === 'relaxed') {
      this.logger.info('Agent force-woken');
      this.sleepState.mode = 'alert';
      this.sleepState.disturbance = 0;
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
   * Update alertness mode based on current state.
   */
  private updateAlertnessMode(): void {
    const pressure = this.calculateReachOutPressure();
    const energy = this.state.energy;
    const hour = new Date().getHours();
    const isNightTime = hour >= 22 || hour < 6;

    // Determine new mode
    let newMode: AlertnessMode;

    if (pressure > 0.7 || this.state.taskPressure > 0.8) {
      newMode = 'alert';
    } else if (isNightTime && pressure < 0.3 && energy < 0.5) {
      newMode = 'sleep';
    } else if (pressure < 0.3 && energy < 0.4) {
      newMode = 'relaxed';
    } else {
      newMode = 'normal';
    }

    if (newMode !== this.sleepState.mode) {
      this.logger.info(
        { from: this.sleepState.mode, to: newMode, pressure, energy },
        'Alertness mode changed'
      );
      this.sleepState.mode = newMode;
    }

    // Decay disturbance
    this.sleepState.disturbance *= this.sleepState.disturbanceDecay;
  }

  /**
   * Calculate the next tick interval based on current state.
   */
  private calculateNextTickInterval(): number {
    const { min, max, base } = this.config.tickRate;

    // Mode-based multiplier
    let modeMultiplier: number;
    switch (this.sleepState.mode) {
      case 'alert':
        modeMultiplier = 0.3; // Much faster
        break;
      case 'normal':
        modeMultiplier = 1.0;
        break;
      case 'relaxed':
        modeMultiplier = 2.0; // Slower
        break;
      case 'sleep':
        modeMultiplier = 4.0; // Much slower
        break;
    }

    // Energy multiplier (low energy = longer intervals)
    const energyMultiplier = this.energy.calculateTickMultiplier();

    // Pressure reduces interval (more alert when under pressure)
    const pressure = this.calculateReachOutPressure();
    const pressureMultiplier = Math.max(0.5, 1 - pressure * 0.5);

    // Calculate final interval
    const interval = base * modeMultiplier * energyMultiplier * pressureMultiplier;

    // Clamp to bounds
    return Math.max(min, Math.min(max, Math.round(interval)));
  }
}

/**
 * Factory function for creating an agent.
 */
export function createAgent(dependencies: AgentDependencies, config?: AgentConfig): Agent {
  return new Agent(dependencies, config);
}
