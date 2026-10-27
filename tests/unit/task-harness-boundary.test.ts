import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const read = (path: string) => readFileSync(path, 'utf8');
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:ts|mjs|js)$/.test(path) ? [path] : [];
  });
}
const filesForNativeScan = () => [
  ...sources('src/ports'),
  'loader/src/task-acp.ts',
  'loader/src/task-harness-factory.ts',
  'loader/src/task-steering-journal.ts',
  'loader/src/task-harness.ts',
  'loader/src/task-launcher.ts',
  'loader/src/task-launcher-main.ts',
];
describe('replaceable task agent boundary', () => {
  it('keeps agent protocols, flags, config paths and constructors out of launcher and core', () => {
    const files = [
      ...sources('src/core'),
      ...sources('src/config'),
      ...sources('src/ports'),
      'loader/src/task-launcher.ts',
      'loader/src/task-launcher-main.ts',
      'loader/src/task-acp.ts',
      'loader/src/task-harness.ts',
      'loader/src/task-steering-journal.ts',
      'loader/src/task-harness-factory.ts',
      'loader/src/settings/platform.ts',
    ];
    for (const file of files) {
      const source = read(file)
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
      expect(source, file).not.toMatch(/opencode|prime-agent|OPENCODE_|OpenCodeTaskHarness/i);
    }
  });
  it('uses one data registry for settings, profile names and runtime selection', () => {
    expect(read('src/ports/task-harness-names.ts')).toContain('task-harness-registry.json');
    expect(read('loader/src/task-harness-registry.ts')).toContain('task-harness-registry.json');
    expect(read('src/config/platform-settings.ts')).toContain('TASK_HARNESS_NAMES');
    expect(read('src/ports/tasks.ts')).toContain('harness: TaskHarnessName');
    expect(read('loader/src/settings/platform.ts')).toContain(
      'Object.entries(taskHarnessRegistry)'
    );
    expect(read('loader/src/task-launcher.ts')).toContain('createRegisteredHarness');
    expect(read('loader/src/task-launcher.ts')).toContain("briefing['harness']");
    expect(read('loader/src/task-launcher-main.ts')).toContain('selfCheckHarnesses');
    const generic = filesForNativeScan().map(read).join('\n');
    expect(generic).not.toMatch(
      /daemon_hello|activeSessionId|delivery:\s*['"]steer|resume:\s*(?:true|false)|node:net|\.sock|inboxID|get_messages|lifemodel-steer:/
    );
    expect(generic).toContain('admit');
    expect(generic).toContain('reconcileEndTurn');
    expect(generic).toContain('TaskSteeringJournal');
    const factory = read('loader/src/task-harness-factory.ts');
    expect(factory).toMatch(/import\(\s*agent\.adapterModule\s*\)/);
    expect(factory).not.toMatch(/opencode|prime-agent/);
    const registry = JSON.parse(read('src/ports/task-harness-registry.json'));
    for (const agent of Object.values(registry) as {
      protocol: string;
      provision: { archives: Record<string, { sha256: string }> };
    }[]) {
      expect(agent.protocol).toBe('acp');
      expect(Object.keys(agent.provision.archives)).toEqual(['x86_64', 'aarch64']);
    }
    expect(read('docker/workbench/Dockerfile')).toContain('task-agent-provision.mjs');
    expect(read('scripts/test-isolated.mjs')).toContain('agentProvisionScript');
    expect(read('scripts/test-docker-isolated.mjs')).toContain('agentInstallScript');
  });
});
