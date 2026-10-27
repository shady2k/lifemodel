/** Prime owns its offline runtime and private configuration. */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
export const usesModelEndpoint = true;
// Python exceptions are reported completed by Prime; see docs/features/motor/task-harness.md.
export const failedToolExemption = 'Prime ACP does not report Python exceptions as failed';
export function shellTool(command: string): { name: string; arguments: string } {
  return {
    name: 'python_repl',
    arguments: JSON.stringify({ code: `await bash(${JSON.stringify(command)})` }),
  };
}
export async function checkProvisioned(): Promise<void> {
  await access('/opt/lifemodel/agents/prime-agent-python/bin/python');
  await access('/opt/lifemodel/agents/prime-agent/prime-agent-runtime');
}
export async function checkOffline(work: string): Promise<void> {
  await expect(access(join(work, 'home/bootstrap-attempt'))).rejects.toThrow();
}
