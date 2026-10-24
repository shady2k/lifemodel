/** Data-only configuration: core never imports a launcher or agent adapter. */
import registry from './task-harness-registry.json' with { type: 'json' };
export const TASK_HARNESS_NAMES = Object.keys(registry) as (keyof typeof registry)[];
export type TaskHarnessName = keyof typeof registry;
const firstHarness = TASK_HARNESS_NAMES[0];
if (!firstHarness) throw new Error('harness_registry_empty');
export const DEFAULT_TASK_HARNESS: TaskHarnessName = firstHarness;
