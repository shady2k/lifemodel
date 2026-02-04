/**
 * Soul System
 *
 * The soul is Nika's living identity - not a static config, but a process
 * of continuous self-interrogation and maintenance.
 *
 * Components:
 * - reflection.ts: Post-response dissonance detection (Phase 3, batch in Phase 3.6)
 * - parliament.ts: Deliberation engine for processing reflections (Phase 4)
 * - revision.ts: Apply changes to soul state (Phase 4)
 * - sleep-maintenance.ts: Sleep cycle maintenance (Phase 5)
 */

export {
  performReflection,
  processBatchReflection,
  shouldProcessBatch,
  type ReflectionResult,
  type ReflectionContext,
  type ReflectionDeps,
  type ReflectionConfig,
  type BatchReflectionResult,
  type BatchReflectionConfig,
} from './reflection.js';

export {
  performDeliberation,
  type DeliberationResult,
  type DeliberationContext,
  type DeliberationDeps,
  type DeliberationConfig,
} from './parliament.js';

export {
  applyRevision,
  type RevisionResult,
  type RevisionContext,
  type RevisionDeps,
} from './revision.js';

export {
  runSleepMaintenance,
  type SleepMaintenanceResult,
  type SleepMaintenanceDeps,
  type SleepMaintenanceConfig,
} from './sleep-maintenance.js';
