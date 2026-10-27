import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { taskHarnessRegistry } from '../../loader/src/task-harness-registry.js';
import { configureAgent, toolOutputFailed } from '../../loader/src/task-prime-agent.js';

const work = mkdtempSync(join(tmpdir(), 'prime-adapter-'));
afterEach(() => rmSync(work, { recursive: true, force: true }));
describe('Prime Agent adapter', () => {
  it('keeps OpenCode default and pins both supported architectures', () => {
    expect(Object.keys(taskHarnessRegistry)).toEqual(['opencode', 'prime-agent']);
    expect(Object.keys(taskHarnessRegistry['prime-agent']!.provision.archives!)).toEqual(['x86_64', 'aarch64']);
  });
  it('renders task-private configuration and disables network bootstrap', () => {
    const env = configureAgent({ workDirectory: work, configFile: 'docker/workbench/prime-models.json', relayBaseURL: 'http://127.0.0.1:1234/v1' });
    const dir = join(work, 'home/.prime/agent');
    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(models.providers.task.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(models.providers.task.apiKey).toBe('task-relay');
    expect(settings).toMatchObject({ defaultProvider: 'task', defaultModel: 'task', telemetry: { enabled: false }, traces: { enabled: false } });
    expect(env).toMatchObject({ PI_OFFLINE: '1', DO_NOT_TRACK: '1', PRIME_AGENT_TELEMETRY: '0', PRIME_AGENT_CODING_AGENT_DIR: dir, PRIME_AGENT_DAEMON_SOCKET: join(work, 'tmp/daemon.sock'), PRIME_AGENT_SESSION_DIR: join(dir, 'sessions') });
    expect(toolOutputFailed({})).toBe(false);
  });
});
