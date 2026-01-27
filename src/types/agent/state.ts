/**
 * Agent internal state.
 *
 * This represents the agent's "mental state" - things that change
 * over time and affect behavior. Like human internal experience,
 * but with explicit, traceable values.
 */
export interface AgentState {
  /** Current energy level (0-1). Affects tick rate and thresholds. */
  energy: number;

  /** Accumulated social debt (0-1). Increases over time without interaction. */
  socialDebt: number;

  /** Pressure from pending tasks (0-1). Increases with unfinished items. */
  taskPressure: number;

  /** General curiosity/engagement level (0-1). */
  curiosity: number;

  /** Timestamp of last tick. */
  lastTickAt: Date;

  /** Current tick interval in milliseconds. Dynamic based on state. */
  tickInterval: number;
}

/**
 * Sleep/alertness mode.
 *
 * Affects which events get processed and how.
 */
export type AlertnessMode = 'alert' | 'normal' | 'relaxed' | 'sleep';

/**
 * Extended state including sleep mechanics.
 */
export interface SleepState {
  /** Current alertness mode */
  mode: AlertnessMode;

  /** Accumulated disturbance from filtered events (0-1) */
  disturbance: number;

  /** Decay rate for disturbance per tick (e.g., 0.95 = 5% decay) */
  disturbanceDecay: number;

  /** Disturbance threshold to wake up */
  wakeThreshold: number;
}

/**
 * Default initial agent state.
 */
export function createDefaultAgentState(): AgentState {
  return {
    energy: 0.8,
    socialDebt: 0.0,
    taskPressure: 0.0,
    curiosity: 0.5,
    lastTickAt: new Date(),
    tickInterval: 30_000, // 30 seconds default
  };
}

/**
 * Default initial sleep state.
 */
export function createDefaultSleepState(): SleepState {
  return {
    mode: 'normal',
    disturbance: 0.0,
    disturbanceDecay: 0.95,
    wakeThreshold: 0.5,
  };
}
