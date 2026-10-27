/** Prime Agent 0.10.1 configuration. The protocol client remains generic ACP. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function configureAgent(input: {
  workDirectory: string;
  configFile: string;
  relayBaseURL: string;
  adapterConfig?: { settingsFile: string; kernelPython: string };
}): NodeJS.ProcessEnv {
  const dir = join(input.workDirectory, 'home/.prime/agent');
  const models = JSON.parse(readFileSync(input.configFile, 'utf8')) as {
    providers: { task: { baseUrl: string } };
  };
  models.providers.task.baseUrl = input.relayBaseURL;
  if (!input.adapterConfig) throw new Error('harness_adapter_config_missing');
  const settings = readFileSync(input.adapterConfig.settingsFile);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'models.json'), JSON.stringify(models), { mode: 0o600 });
  writeFileSync(join(dir, 'settings.json'), settings, { mode: 0o600 });
  return {
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_CODING_AGENT_DIR: dir,
    PRIME_AGENT_SESSION_DIR: join(dir, 'sessions'),
    PRIME_AGENT_DAEMON_SOCKET: join(input.workDirectory, 'tmp/daemon.sock'),
    PRIME_AGENT_KERNEL_PYTHON: input.adapterConfig.kernelPython,
  };
}

/** Prime's Python exceptions lack structured failure evidence (ADR-014). */
export function toolOutputFailed(_output: unknown): boolean {
  return false;
}

/** Version probing must not start update or telemetry activity. */
export function versionCheckEnv(workDirectory: string): NodeJS.ProcessEnv {
  return {
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1',
    PRIME_AGENT_TELEMETRY: '0',
    PRIME_AGENT_CODING_AGENT_DIR: join(workDirectory, 'agent'),
    PRIME_AGENT_SESSION_DIR: join(workDirectory, 'sessions'),
    PRIME_AGENT_DAEMON_SOCKET: join(workDirectory, 'daemon.sock'),
  };
}
