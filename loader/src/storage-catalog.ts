/**
 * The storage module's Postgres catalog (ADR-015 S-D4, S-D7).
 *
 * Readiness answers whether the module can use its own catalog right now: the
 * one `storage.spaces` read proves the connection, the login and the schema in
 * one statement. An unreachable server, a refused login and a missing schema
 * are three different repairs, so each keeps its own cause in the module's log;
 * the status body carries the one reason code `catalog_unavailable`.
 *
 * The read ends at the caller's deadline: an aborted check closes its
 * connection instead of leaving a query behind, and a late answer belongs to a
 * health evaluation that has already been answered.
 */
import { Client } from 'pg';

/**
 * The one statement readiness runs. It must read a catalog table rather than
 * the schema: an existing schema with no table is not a usable catalog, and an
 * empty table is (S-D7: never "empty", only unavailable).
 */
export const STORAGE_CATALOG_READ = 'SELECT 1 FROM storage.spaces LIMIT 1';

/** The login the module uses until lifemodel-2t5 gives it a leased identity. */
export const STORAGE_DATABASE_TARGET =
  'lifemodel-rw.lifemodel-state.svc.cluster.local:5432/lifemodel';

export type CatalogFailureCause =
  | 'unreachable'
  | 'auth_failed'
  | 'schema_missing'
  | 'forbidden'
  | 'timeout'
  | 'failed';

export type CatalogCheck = { ok: true } | { ok: false; cause: CatalogFailureCause };

export interface Catalog {
  /** One bounded read of the catalog; the signal ends work its deadline answered. */
  check(signal: AbortSignal): Promise<CatalogCheck>;
}

export interface CatalogOptions {
  connectionString: string;
  /** How long one read may take; it stays below the module health bound. */
  timeoutMs?: number;
}

/** The module's own bound, inside `STORAGE_HEALTH_DEFAULTS.boundMs`. */
export const STORAGE_CATALOG_DEFAULTS = { timeoutMs: 2_000 } as const;

/** A SQLSTATE is five characters; a socket, DNS or TLS failure carries its own code. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/** What a failed read means, in the words of the repair it needs. */
export function catalogCause(error: unknown): CatalogFailureCause {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string' || !SQLSTATE.test(code)) return 'unreachable';
  // 28P01 invalid_password, 28000 invalid_authorization_specification
  if (code === '28P01' || code === '28000') return 'auth_failed';
  // 3D000 invalid_catalog_name, 3F000 invalid_schema_name, 42P01 undefined_table
  if (code === '3D000' || code === '3F000' || code === '42P01') return 'schema_missing';
  // 42501 insufficient_privilege: the table exists and this login cannot read it.
  if (code === '42501') return 'forbidden';
  return 'failed';
}

/** The login of the module's catalog: `postgresql://user:password@host:port/database`. */
export function catalogConnectionString(
  username: string,
  password: string,
  target: string = STORAGE_DATABASE_TARGET
): string {
  if (username === '' || password === '')
    throw new Error('the storage catalog login needs a username and a password');
  return `postgresql://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${target}`;
}

/**
 * One short-lived connection per check: readiness runs every few seconds, and a
 * long-lived pool would hold a server connection open for the module's life
 * without making the answer newer.
 */
export function createCatalog(options: CatalogOptions): Catalog {
  const timeoutMs = options.timeoutMs ?? STORAGE_CATALOG_DEFAULTS.timeoutMs;
  return {
    check: async (signal) => {
      // A deadline that has already passed is not worth a connection.
      if (signal.aborted) return { ok: false, cause: 'timeout' };
      const client = new Client({
        connectionString: options.connectionString,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        application_name: 'lifemodel-storage-module',
      });
      /**
       * A dropped connection rejects the running query AND emits `error` on the
       * client: the first reaches the catch below, the second would reach the
       * process and kill the module that is meant to report the outage. The
       * listener is attached before `connect()`, kept through teardown - where
       * the dying socket may report again - and only records, so the check
       * answers unhealthy with the transport error's own cause.
       */
      let transportError: unknown;
      client.on('error', (error: unknown) => {
        transportError = error;
      });
      // A refused or silent server must not outlive the check that asked.
      const abort = (): void => {
        client.end().catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        await client.connect();
        await client.query(STORAGE_CATALOG_READ);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          cause: signal.aborted ? 'timeout' : catalogCause(transportError ?? error),
        };
      } finally {
        signal.removeEventListener('abort', abort);
        await client.end().catch(() => undefined);
      }
    },
  };
}
