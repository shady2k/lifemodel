/**
 * Soul System
 *
 * The soul is Nika's living identity - not a static config, but a process
 * of continuous self-interrogation and maintenance.
 *
 * Components:
 * - reflection.ts: Post-response dissonance detection (Phase 3)
 * - parliament.ts: Deliberation engine for processing reflections (Phase 4, future)
 * - revision.ts: Apply changes to soul state (Phase 4, future)
 */

export {
  performReflection,
  type ReflectionResult,
  type ReflectionContext,
  type ReflectionDeps,
  type ReflectionConfig,
} from './reflection.js';
