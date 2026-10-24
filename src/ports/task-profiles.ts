import type { TaskProfile } from './tasks.js';

/** Versioned core admission choices, not model-selected resource ceilings. */
export const TASK_PROFILES: Readonly<Record<string, TaskProfile>> = Object.freeze({
  small: Object.freeze({
    id: 'small',
    revision: '1',
    timeoutSeconds: 600,
    cpuMillis: 500,
    memoryBytes: 536870912,
  }),
});
