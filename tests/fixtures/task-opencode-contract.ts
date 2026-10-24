/** OpenCode-owned config and offline assertions, not shared-suite policy. */
import { expect } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
export const usesModelEndpoint = true;
export async function checkProvisioned(): Promise<void> {
  await access('/etc/lifemodel/xdg/opencode');
}
export async function checkOffline(work: string): Promise<void> {
  await expect(access(join(work, 'home/bootstrap-attempt'))).rejects.toThrow();
  await expect(access('/etc/lifemodel/xdg/opencode/package.json')).rejects.toThrow();
  await expect(access(join(work, '.opencode'))).rejects.toThrow();
}
