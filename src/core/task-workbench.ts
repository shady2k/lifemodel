import { TaskRegistryError, type TaskAcceptanceService } from '../ports/tasks.js';

const WORKBENCH_MANIFESTS =
  'http://zot.lifemodel-system.svc:5001/v2/lifemodel/workbench/manifests/';
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

/** Probe the durable registry, not a cached loader state. Anonymous HTTP stays
 * inside the platform's fixed zot authority. No credentials, redirects, bodies,
 * retries or successful-result cache: each new acceptance has a finite check.
 * Zot commits a manifest only after its blobs exist; HEAD avoids downloading it.
 */
export function createTaskWorkbenchReadiness(
  options: {
    fetch?: typeof fetch;
    timeoutMs?: number;
  } = {}
): (imageRevision: string) => Promise<boolean> {
  const send = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 2000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2000)
    throw new Error('Invalid workbench readiness timeout');
  return async (imageRevision) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(imageRevision)) return false;
    try {
      const response = await send(`${WORKBENCH_MANIFESTS}${imageRevision}`, {
        method: 'HEAD',
        headers: { accept: MANIFEST_ACCEPT },
        credentials: 'omit',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      // HEAD has no response body. Do not retain bytes from a nonconforming peer.
      void response.body?.cancel().catch(() => undefined);
      return (
        response.status === 200 && response.headers.get('docker-content-digest') === imageRevision
      );
    } catch {
      return false;
    }
  };
}

/** Refusal precedes registry acceptance, storage allocation and Job creation.
 * TaskRegistryError reuses the start tool's existing honest refusal path.
 */
export function createWorkbenchTaskService(options: {
  service: TaskAcceptanceService;
  imageRevision: string;
  ready: (imageRevision: string) => Promise<boolean>;
  onAccepted: () => void;
}): TaskAcceptanceService {
  return {
    accept: async (request) => {
      // Recover an accepted effect even when a rollout's new image is not ready.
      // The registry still checks the full original payload and its epoch fence;
      // this read is not permission to insert a new task without readiness.
      const existing = await options.service.readByLaunchKey(request.launchKey);
      if (!existing && !(await options.ready(options.imageRevision)))
        throw new TaskRegistryError('', 'workbench_unavailable');
      const task = await options.service.accept(request);
      options.onAccepted();
      return task;
    },
    read: (id) => options.service.read(id),
    readByLaunchKey: (key) => options.service.readByLaunchKey(key),
    list: () => options.service.list(),
  };
}
