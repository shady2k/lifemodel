import type { Pool } from 'pg';
import type { TaskFinalizationCandidate, TaskRecord, TaskRegistry } from '../../src/ports/tasks.js';

/** Build a terminal fixture through the same sealed boundary as the core. */
export async function finalizeTaskFixture(
  pool: Pool,
  registry: TaskRegistry,
  task: Pick<TaskRecord, 'id' | 'launchId'>,
  candidate: TaskFinalizationCandidate
): Promise<void> {
  let current = await registry.beginFinalization(task.id, task.launchId, candidate);
  await registry.confirmComputeTerminated(task.id, task.launchId);
  if (!current.allocationReceipt) {
    current = await registry.recordAllocation(task.id, task.launchId, {
      id: `receipt-${task.id}`,
      space: `space-${task.id}`,
      effectKey: `${task.launchId}:allocate`,
    });
  }
  await pool.query('INSERT INTO storage.spaces(id) VALUES($1) ON CONFLICT DO NOTHING', [
    current.allocationReceipt!.space,
  ]);
  const prepared = await registry.prepareSeal(task.id, task.launchId);
  const seal = prepared.sealRequest!;
  await registry.recordSealReceipt(task.id, task.launchId, seal.candidateRevision, {
    id: `seal-${task.id}`,
    space: seal.space,
    effectKey: seal.effectKey,
    revision: String(BigInt(seal.expectedRevision) + 1n),
    outcome: seal.outcome,
    state: 'sealed',
    reason: null,
    manifest: {
      id: `manifest-${task.id}`,
      version: 1,
      sha256: 'a'.repeat(64),
      objects:
        candidate.state === 'done'
          ? [{ id: 'result', name: 'result.txt', size: 0, sha256: 'a'.repeat(64), mark: 'result' }]
          : [],
    },
  });
  await registry.commitFinalization(task.id, task.launchId, prepared.candidateRevision);
}
