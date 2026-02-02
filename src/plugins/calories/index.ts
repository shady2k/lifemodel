/**
 * Calories Plugin
 *
 * A plugin for tracking food intake, calories, and body weight with
 * proactive engagement via a neuron that monitors calorie deficit.
 *
 * Features:
 * - Food logging with LLM calorie estimation
 * - Custom dish learning (auto-created when user provides calories)
 * - Weight tracking with weekly check-in reminders
 * - Calorie goal setting (manual or TDEE-based calculation)
 * - Neuron-based deficit monitoring (proactive reminders)
 *
 * This plugin follows the principle of zero core changes - the neuron
 * reads directly from plugin storage rather than requiring state enrichment.
 */

import type { Logger } from '../../types/logger.js';
import type {
  PluginV2,
  PluginManifestV2,
  PluginLifecycleV2,
  PluginPrimitives,
  PluginTool,
  ScheduleEntry,
  EventSchema,
} from '../../types/plugin.js';
import type { Neuron } from '../../layers/autonomic/neuron-registry.js';
import { createCaloriesTool } from './calories-tool.js';
import {
  CaloriesDeficitNeuron,
  DEFAULT_CALORIES_DEFICIT_CONFIG,
  type CaloriesDeficitNeuronConfig,
} from './calories-neuron.js';
import {
  CALORIES_PLUGIN_ID,
  CALORIES_EVENT_KINDS,
  weightCheckinSchema,
  type WeightEntry,
  CALORIES_STORAGE_KEYS,
} from './calories-types.js';
import { DateTime } from 'luxon';

/**
 * Plugin state (set during activation).
 */
let pluginPrimitives: PluginPrimitives | null = null;
let pluginTools: PluginTool[] = [];

/**
 * Neuron instance (created via factory, stored for reference).
 */
let neuronInstance: CaloriesDeficitNeuron | null = null;

/**
 * Plugin manifest.
 */
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  id: CALORIES_PLUGIN_ID,
  name: 'Calories Tracking Plugin',
  version: '1.0.0',
  description:
    'Track food intake, calories, and body weight with proactive deficit monitoring and weekly weight check-ins',
  provides: [
    { type: 'tool', id: 'calories' },
    { type: 'neuron', id: 'calories-deficit' },
  ],
  requires: ['scheduler', 'storage', 'signalEmitter', 'logger'],
  limits: {
    maxSchedules: 10, // Just weight check-in schedules
    maxStorageMB: 50, // Food logs can grow over time
  },
};

/**
 * Get user patterns from UserModel via plugin services.
 */
function createGetUserPatterns(
  primitives: PluginPrimitives,
  recipientId: string
): () => { wakeHour?: number; sleepHour?: number } | null {
  return () => {
    const patterns = primitives.services.getUserPatterns(recipientId);
    if (!patterns) return null;
    const result: { wakeHour?: number; sleepHour?: number } = {};
    if (patterns.wakeHour !== null) {
      result.wakeHour = patterns.wakeHour;
    }
    if (patterns.sleepHour !== null) {
      result.sleepHour = patterns.sleepHour;
    }
    return result;
  };
}

/**
 * Get calorie goal from user model via plugin services.
 */
function createGetCalorieGoal(
  primitives: PluginPrimitives,
  recipientId: string
): () => Promise<number | null> {
  return () => {
    const prop = primitives.services.getUserProperty('calorie_goal', recipientId);
    if (!prop || typeof prop.value !== 'number') return Promise.resolve(null);
    return Promise.resolve(prop.value);
  };
}

/**
 * User model data structure for TDEE calculation.
 */
interface UserModelData {
  weight_kg?: number;
  height_cm?: number;
  birthday?: string;
  gender?: string;
  activity_level?: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  calorie_goal?: number;
  target_weight_kg?: number;
}

/**
 * Parse a value as a number, handling both number and string types.
 * core.remember stores values as strings, so we need to parse them.
 */
function parseNumber(val: unknown): number | undefined {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const parsed = parseFloat(val);
    if (!isNaN(parsed)) return parsed;
  }
  return undefined;
}

/**
 * Get user model data for TDEE calculation via plugin services.
 */
function createGetUserModel(
  primitives: PluginPrimitives
): (recipientId: string) => Promise<UserModelData | null> {
  return (recipientId: string) => {
    const getProp = (attr: string): unknown => {
      const prop = primitives.services.getUserProperty(attr, recipientId);
      return prop?.value;
    };

    const weight = getProp('weight_kg');
    const height = getProp('height_cm');
    const birthday = getProp('birthday');
    const gender = getProp('gender');
    const activity = getProp('activity_level');
    const goal = getProp('calorie_goal');
    const target = getProp('target_weight_kg');

    // Return null if no data at all
    if (!weight && !height && !birthday && !gender) {
      return Promise.resolve(null);
    }

    // Build result only with defined values (exactOptionalPropertyTypes)
    // Note: core.remember stores values as strings, so we parse numeric fields
    const result: UserModelData = {};

    const parsedWeight = parseNumber(weight);
    const parsedHeight = parseNumber(height);
    const parsedGoal = parseNumber(goal);
    const parsedTarget = parseNumber(target);

    if (parsedWeight !== undefined) result.weight_kg = parsedWeight;
    if (parsedHeight !== undefined) result.height_cm = parsedHeight;
    if (typeof birthday === 'string') result.birthday = birthday;
    if (typeof gender === 'string') result.gender = gender;
    if (
      activity === 'sedentary' ||
      activity === 'light' ||
      activity === 'moderate' ||
      activity === 'active' ||
      activity === 'very_active'
    ) {
      result.activity_level = activity;
    }
    if (parsedGoal !== undefined) result.calorie_goal = parsedGoal;
    if (parsedTarget !== undefined) result.target_weight_kg = parsedTarget;

    return Promise.resolve(result);
  };
}

/**
 * Calculate next Sunday at a specific hour.
 */
function nextSundayAt(hour: number, timezone: string): Date {
  const now = DateTime.now().setZone(timezone);
  let next = now.set({ hour, minute: 0, second: 0, millisecond: 0 });

  // Find next Sunday
  const daysUntilSunday = (7 - now.weekday) % 7;
  if (daysUntilSunday === 0 && now.hour >= hour) {
    // It's Sunday but past the hour, go to next Sunday
    next = next.plus({ days: 7 });
  } else {
    next = next.plus({ days: daysUntilSunday });
  }

  return next.toJSDate();
}

/**
 * Schedule weekly weight check-in (restart-safe).
 */
async function scheduleWeightCheckin(
  primitives: PluginPrimitives,
  recipientId: string,
  userTimezone: string
): Promise<void> {
  const scheduleId = `weight_checkin_${recipientId}`;

  // Check if valid schedule already exists (restart-safe)
  const existing = await primitives.scheduler.getSchedules();
  const hasValidSchedule = existing.some(
    (s: ScheduleEntry) => s.id === scheduleId && s.nextFireAt > new Date()
  );

  if (hasValidSchedule) {
    primitives.logger.debug({ scheduleId }, 'Weight check-in schedule already exists');
    return;
  }

  // Get user's wake hour pattern from UserModel
  const userPatterns = primitives.services.getUserPatterns(recipientId);
  // If no wake hour learned yet, wait until we have data to schedule appropriately
  if (!userPatterns?.wakeHour) {
    primitives.logger.debug(
      { scheduleId },
      'No wake hour pattern available, skipping weight check-in schedule'
    );
    return;
  }
  const bestHour = userPatterns.wakeHour + 1; // 1 hour after wake

  await primitives.scheduler.schedule({
    id: scheduleId,
    fireAt: nextSundayAt(bestHour, userTimezone),
    recurrence: { frequency: 'weekly', interval: 1 },
    timezone: userTimezone,
    data: {
      kind: CALORIES_EVENT_KINDS.WEIGHT_CHECKIN,
      recipientId,
    },
  });

  primitives.logger.info(
    { scheduleId, hour: bestHour, timezone: userTimezone },
    'Weight check-in scheduled'
  );
}

/**
 * Handle weight check-in event.
 */
async function handleWeightCheckin(
  payload: { recipientId: string },
  primitives: PluginPrimitives
): Promise<void> {
  const { recipientId } = payload;

  // Get last weight entry
  const weights = await primitives.storage.get<WeightEntry[]>(CALORIES_STORAGE_KEYS.weights);
  const userWeights = (weights ?? [])
    .filter((w) => w.recipientId === recipientId)
    .sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime());

  const lastWeight = userWeights[0];

  let thoughtContent: string;
  if (lastWeight) {
    const daysSince = Math.floor(
      (Date.now() - new Date(lastWeight.measuredAt).getTime()) / (1000 * 60 * 60 * 24)
    );
    thoughtContent = `Time for the weekly weight check-in! Last recorded weight was ${String(lastWeight.weight)} kg, ${String(daysSince)} days ago. Ask the user about their current weight and celebrate progress or offer support.`;
  } else {
    thoughtContent = `Time for a weight check-in! No previous weight recorded. Ask the user if they'd like to start tracking their weight for health goals.`;
  }

  // Emit thought for COGNITION to process
  primitives.intentEmitter.emitThought(thoughtContent);

  primitives.logger.info({ recipientId, hasLastWeight: !!lastWeight }, 'Weight check-in triggered');
}

/**
 * Plugin lifecycle.
 */
const lifecycle: PluginLifecycleV2 = {
  activate(primitives: PluginPrimitives): void {
    pluginPrimitives = primitives;
    primitives.logger.info({}, 'Calories plugin activating');

    // Register event schema for weight check-in
    primitives.services.registerEventSchema(
      CALORIES_EVENT_KINDS.WEIGHT_CHECKIN,
      weightCheckinSchema as unknown as EventSchema
    );

    // Create tools
    pluginTools = [
      createCaloriesTool(
        primitives,
        (recipientId) => primitives.services.getTimezone(recipientId),
        (recipientId) => createGetUserPatterns(primitives, recipientId)(),
        createGetUserModel(primitives)
      ),
    ];

    primitives.logger.info({}, 'Calories plugin activated');
  },

  deactivate(): void {
    if (pluginPrimitives) {
      pluginPrimitives.logger.info({}, 'Calories plugin deactivating');
    }
    pluginPrimitives = null;
    pluginTools = [];
    neuronInstance = null;
  },

  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!pluginPrimitives) {
      return { healthy: false, message: 'Plugin not activated' };
    }
    try {
      await pluginPrimitives.storage.keys();
      return { healthy: true };
    } catch (error) {
      return {
        healthy: false,
        message: `Storage error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },

  async onEvent(eventKind: string, payload: Record<string, unknown>): Promise<void> {
    if (!pluginPrimitives) return;

    if (eventKind === CALORIES_EVENT_KINDS.WEIGHT_CHECKIN) {
      const recipientId = payload['recipientId'];
      if (typeof recipientId !== 'string') {
        pluginPrimitives.logger.error(
          { payload },
          'Invalid weight checkin payload: missing recipientId'
        );
        return;
      }
      await handleWeightCheckin({ recipientId }, pluginPrimitives);
    }
  },
};

/**
 * Neuron factory configuration.
 *
 * Note: The neuron requires additional dependencies (storage, timezone getter, etc.)
 * that are injected at creation time. This is different from simple neurons like
 * SocialDebtNeuron that only read from AgentState.
 */
interface CaloriesNeuronFactoryConfig {
  neuronConfig?: Partial<CaloriesDeficitNeuronConfig>;
  recipientId?: string;
}

/**
 * Calories plugin with neuron factory.
 */
const caloriesPlugin: PluginV2 & {
  neuron: {
    create: (logger: Logger, config?: unknown) => Neuron;
    defaultConfig: CaloriesDeficitNeuronConfig;
  };
} = {
  manifest,
  lifecycle,

  // Tools getter - returns tools created during activation
  get tools() {
    return pluginTools;
  },

  // Neuron factory
  neuron: {
    create: (logger: Logger, config?: unknown): Neuron => {
      if (!pluginPrimitives) {
        throw new Error('Cannot create neuron: plugin not activated');
      }
      // Capture reference after guard - closures below execute later when pluginPrimitives could change
      const primitives = pluginPrimitives;

      const factoryConfig = (config ?? {}) as CaloriesNeuronFactoryConfig;
      const recipientId = factoryConfig.recipientId ?? 'default';

      neuronInstance = new CaloriesDeficitNeuron(
        logger,
        factoryConfig.neuronConfig ?? {},
        primitives.storage,
        () => primitives.services.getTimezone(recipientId),
        () => createGetUserPatterns(primitives, recipientId)(),
        createGetCalorieGoal(primitives, recipientId)
      );

      // Schedule weight check-in when neuron is created
      const timezone = primitives.services.getTimezone(recipientId);
      scheduleWeightCheckin(primitives, recipientId, timezone).catch((err: unknown) => {
        logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'Failed to schedule weight check-in'
        );
      });

      return neuronInstance;
    },
    defaultConfig: DEFAULT_CALORIES_DEFICIT_CONFIG,
  },
};

export default caloriesPlugin;

// Re-export types for external use
export type {
  FoodEntry,
  CustomDish,
  WeightEntry,
  DailySummary,
  CaloriesToolResult,
} from './calories-types.js';
export {
  CALORIES_PLUGIN_ID,
  CALORIES_EVENT_KINDS,
  CALORIES_STORAGE_KEYS,
} from './calories-types.js';
export type { CaloriesDeficitNeuronConfig } from './calories-neuron.js';
