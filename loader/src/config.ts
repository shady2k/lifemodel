/** Configuration for the platform loader (ADR-010, platform step A0). */
import { join } from 'node:path';
import { LoaderFatalError } from './errors.js';

export interface LoaderConfig {
  /** Writable persistent state owned by the platform loader. */
  volumeRoot: string;
  loaderDir: string;
  httpPort: number;
  /** Fixed DNS label for this installation. */
  instanceName: string;
  /** OpenBao HTTP API endpoint used during platform bootstrap. */
  openBaoAddress: string;
  /** The platform gateway's health listener, read by the settings page (ADR-013 D6). */
  modelStatusUrl: string;
  /** The log store's HTTP base, read by the logs page (ADR-016 §4, P12). */
  logsStoreUrl: string;
}

/** The gateway's own listener on its Service, pinned by ADR-013 D5/D6. */
const DEFAULT_MODEL_STATUS_URL = 'http://model-gateway.lifemodel-system.svc:8081/status';

/** The log store's Service listener (ADR-016 §3, §4). */
const DEFAULT_LOGS_STORE_URL = 'http://logs-store.lifemodel-system.svc:9428';

function readHttpUrl(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new LoaderFatalError(`${name} must be an HTTP URL, got "${raw}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new LoaderFatalError(`${name} must be an HTTP URL, got "${raw}"`);
  return parsed.pathname === '/' && parsed.search === '' && parsed.hash === ''
    ? parsed.origin
    : parsed.href;
}

function readModelStatusUrl(env: NodeJS.ProcessEnv): string {
  return readHttpUrl(env, 'LIFEMODEL_MODEL_GATEWAY_STATUS_URL', DEFAULT_MODEL_STATUS_URL);
}

function readLogsStoreUrl(env: NodeJS.ProcessEnv): string {
  return readHttpUrl(env, 'LIFEMODEL_LOGS_STORE_URL', DEFAULT_LOGS_STORE_URL);
}

function readPort(env: NodeJS.ProcessEnv): number {
  const raw = env['LIFEMODEL_HTTP_PORT'];
  if (raw === undefined || raw === '') return 7000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new LoaderFatalError(`LIFEMODEL_HTTP_PORT must be a valid port, got "${raw}"`);
  }
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv): LoaderConfig {
  const instanceName = env['LIFEMODEL_NAME'];
  if (
    !instanceName ||
    !/^[a-z](?:[a-z0-9-]{0,55}[a-z0-9])?$/.test(instanceName) ||
    instanceName.length > 57 ||
    ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null', '~'].includes(instanceName)
  )
    throw new LoaderFatalError(
      'LIFEMODEL_NAME must be a non-reserved DNS-1035 label of at most 57 characters'
    );
  const volumeRoot = env['LIFEMODEL_VOLUME_ROOT'] ?? '/var/lib/loader';
  return {
    volumeRoot,
    loaderDir: join(volumeRoot, 'loader'),
    httpPort: readPort(env),
    openBaoAddress: env['LIFEMODEL_OPENBAO_ADDRESS'] ?? 'http://openbao.openbao.svc:8200',
    modelStatusUrl: readModelStatusUrl(env),
    logsStoreUrl: readLogsStoreUrl(env),
    instanceName,
  };
}
