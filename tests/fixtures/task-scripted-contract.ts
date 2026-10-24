import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export const usesModelEndpoint = false;
export async function prepare(work: string, mode: string): Promise<void> {
  await writeFile(join(work, 'scenario'), mode);
}
export async function checkProvisioned(): Promise<void> {}
export async function checkOffline(_work: string): Promise<void> {}
