/** Prime owns its offline runtime and private configuration. */
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
export const usesModelEndpoint = true;
export async function checkProvisioned(): Promise<void> {
  await access('/opt/lifemodel/agents/prime-agent-python/bin/python');
  await access('/opt/lifemodel/agents/prime-agent/prime-agent-runtime');
}
export async function checkOffline(work: string): Promise<void> {
  await expect(access(join(work, 'home/bootstrap-attempt'))).rejects.toThrow();
}
