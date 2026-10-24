/** The external workbench pull source. Its secret lives only in loader Bao custody. */
export interface WorkbenchSource {
  registry: string;
  repository: string;
  username?: string;
  password?: string;
}
/** The only shipped external source; every runtime consumer reads the setting. */
export const DEFAULT_WORKBENCH_SOURCE: Readonly<WorkbenchSource> = Object.freeze({
  registry: 'https://ghcr.io',
  repository: 'shady2k/lifemodel-workbench',
});
export const WORKBENCH_SOURCE_PATH = 'lifemodel/data/workbench/source';
export class WorkbenchSourceError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('invalid_workbench_source');
    this.name = 'WorkbenchSourceError';
  }
}
const REPOSITORY =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
function hasControl(value: string, includeSpace = false): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < (includeSpace ? 33 : 32) || code === 127) return true;
  }
  return false;
}
/** Missing source fields are errors. An omitted secret can keep the existing credential. */
export function validateWorkbenchSource(
  value: unknown,
  previous?: WorkbenchSource
): WorkbenchSource {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new WorkbenchSourceError({ body: 'object_required' });
  const input = value as Record<string, unknown>;
  const fields: Record<string, string> = {};
  if (
    Object.keys(input).some(
      (key) => !['registry', 'repository', 'username', 'password'].includes(key)
    )
  )
    fields['body'] = 'unknown_field';
  let registry = '';
  if (typeof input['registry'] !== 'string' || input['registry'].length === 0)
    fields['registry'] = 'required';
  else {
    try {
      const raw = input['registry'];
      const url = new URL(raw);
      if (
        raw.length > 2048 ||
        raw !== raw.trim() ||
        hasControl(raw, true) ||
        raw.includes('\\') ||
        raw.includes('@') ||
        !/^https:\/\/[^/?#]+\/?$/.test(raw) ||
        url.protocol !== 'https:' ||
        !url.hostname ||
        url.username ||
        url.password ||
        url.pathname !== '/' ||
        url.search ||
        url.hash
      )
        fields['registry'] = 'https_origin_required';
      else registry = url.origin;
    } catch {
      fields['registry'] = 'https_origin_required';
    }
  }
  const repository = input['repository'];
  if (typeof repository !== 'string' || repository.length === 0) fields['repository'] = 'required';
  else if (repository.length > 255 || !REPOSITORY.test(repository))
    fields['repository'] = 'oci_repository_required';
  const username = input['username'];
  const password = input['password'];
  if (
    username !== undefined &&
    (typeof username !== 'string' ||
      username.length > 256 ||
      hasControl(username, true) ||
      username.includes(':'))
  )
    fields['username'] = 'invalid_username';
  if (
    password !== undefined &&
    (typeof password !== 'string' ||
      password.length > 4096 ||
      hasControl(password) ||
      (password !== '' && password.trim() === ''))
  )
    fields['password'] = 'invalid_password';
  if (
    typeof password === 'string' &&
    password !== '' &&
    (typeof username !== 'string' || username === '')
  )
    fields['username'] = 'required_for_password';
  const keptPassword =
    password === undefined &&
    previous?.registry === registry &&
    previous.repository === repository &&
    previous.username === username
      ? previous.password
      : undefined;
  if (typeof username === 'string' && username !== '' && password === undefined && !keptPassword)
    fields['password'] = 'required_for_username';
  if (Object.keys(fields).length) throw new WorkbenchSourceError(fields);
  const source: WorkbenchSource = { registry, repository: repository as string };
  // Explicit empty password clears the entire credential, never a half-pair.
  if (typeof username === 'string' && username !== '' && password !== '') {
    source.username = username;
    const effectivePassword = typeof password === 'string' ? password : keptPassword;
    if (effectivePassword !== undefined) source.password = effectivePassword;
  }
  return source;
}
/** Never serialize the private source at an HTTP or logging boundary. */
export function publicWorkbenchSource(source: WorkbenchSource): {
  registry: string;
  repository: string;
  username?: string;
  hasPassword: boolean;
} {
  return {
    registry: source.registry,
    repository: source.repository,
    ...(source.username ? { username: source.username } : {}),
    hasPassword: Boolean(source.password),
  };
}
