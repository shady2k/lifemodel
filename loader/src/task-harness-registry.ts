/** Data-only agent registry shared with core settings; no core runtime import. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { validateAgentRegistry } from '../../src/ports/task-agent-validation.mjs';

export interface AgentConfiguration {
  adapterModule: string;
  contractModule?: string;
  label: string;
  protocol: string;
  command: string;
  args: string[];
  configFile: string;
  version: string;
  versionOutput: string;
  versionArgs: string[];
  adapterConfig?: { settingsFile: string; kernelPython: string };
  provision: { archives?: Record<string, unknown> };
}
export const taskHarnessRegistry = validateAgentRegistry(
  JSON.parse(
    readFileSync(new URL('../../src/ports/task-harness-registry.json', import.meta.url), 'utf8')
  ) as Record<string, AgentConfiguration>
);
export const taskHarnessNames = Object.keys(taskHarnessRegistry);
const firstHarness = taskHarnessNames[0];
if (!firstHarness) throw new Error('harness_registry_empty');
export const defaultTaskHarness = firstHarness;

export async function selfCheckHarnesses(): Promise<string[]> {
  const checked: string[] = [];
  for (const agent of Object.values(taskHarnessRegistry)) {
    await access(agent.configFile);
    const adapter = (await import(agent.adapterModule)) as {
      versionCheckEnv?: (workDirectory: string) => NodeJS.ProcessEnv;
    };
    const work = mkdtempSync(join(tmpdir(), 'harness-version-'));
    let version: string;
    try {
      version = execFileSync(agent.command, agent.versionArgs, {
        encoding: 'utf8',
        timeout: 10_000,
        maxBuffer: 65536,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, HOME: work, ...adapter.versionCheckEnv?.(work) },
      }).trim();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
    if (version !== agent.versionOutput) throw new Error('harness_version_invalid');
    checked.push(`${agent.label}: ${version}`);
  }
  return checked;
}
