import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taskHarnessRegistry } from '../../loader/src/task-harness-registry.js';
import { configureAgent, toolOutputFailed, versionCheckEnv } from '../../loader/src/task-prime-agent.js';

let work: string;
beforeEach(() => { work = mkdtempSync(join(tmpdir(), 'prime-adapter-')); });
afterEach(() => rmSync(work, { recursive: true, force: true }));
describe('Prime Agent adapter', () => {
  it('keeps OpenCode default and pins both supported architectures', () => {
    expect(Object.keys(taskHarnessRegistry)).toEqual(['opencode', 'prime-agent']);
    expect(Object.keys(taskHarnessRegistry['prime-agent']!.provision.archives!)).toEqual(['x86_64', 'aarch64']);
  });
  it('renders task-private configuration and disables network bootstrap', () => {
    const env = configureAgent({ workDirectory: work, configFile: 'docker/workbench/prime-models.json', relayBaseURL: 'http://127.0.0.1:1234/v1', adapterConfig: { settingsFile: 'docker/workbench/prime-settings.json', kernelPython: '/opt/lifemodel/agents/prime-agent-python/bin/python' } });
    const dir = join(work, 'home/.prime/agent');
    const models = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8'));
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(models.providers.task.baseUrl).toBe('http://127.0.0.1:1234/v1');
    const original = JSON.parse(readFileSync('docker/workbench/prime-models.json', 'utf8'));
    original.providers.task.baseUrl = 'http://127.0.0.1:1234/v1';
    expect(models).toEqual(original);
    expect(taskHarnessRegistry['prime-agent']!.args).toEqual(['--mode', 'acp', '--offline', '--no-session', '--provider', 'task', '--model', 'task']);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'models.json')).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'settings.json')).mode & 0o777).toBe(0o600);
    expect(settings).toMatchObject({ defaultProvider: 'task', defaultModel: 'task', telemetry: { enabled: false }, traces: { enabled: false } });
    expect(env).toMatchObject({ PI_OFFLINE: '1', DO_NOT_TRACK: '1', PRIME_AGENT_TELEMETRY: '0', PRIME_AGENT_CODING_AGENT_DIR: dir, PRIME_AGENT_DAEMON_SOCKET: join(work, '.launcher/daemon.sock'), PRIME_AGENT_SESSION_DIR: join(dir, 'sessions') });
    expect(env['PRIME_AGENT_KERNEL_PYTHON']).toBe(taskHarnessRegistry['prime-agent']!.adapterConfig!.kernelPython);
    expect(versionCheckEnv(work)).toMatchObject({ PI_OFFLINE: '1', DO_NOT_TRACK: '1', PRIME_AGENT_TELEMETRY: '0', PRIME_AGENT_CODING_AGENT_DIR: join(work, 'agent') });
    expect(toolOutputFailed({})).toBe(false);
  });
});
