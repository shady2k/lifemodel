/**
 * Credential Store
 *
 * Phase 2 implementation: env-var based credential storage.
 * Maps `VAULT_<NAME>` environment variables.
 *
 * Credentials are referenced in tool arguments as `<credential:name>` placeholders.
 * Resolution happens at tool execution time only — never stored in conversation history.
 */

/**
 * Credential store interface.
 *
 * Phase 2 uses env vars. Phase 3+ may use encrypted keychain.
 */
export interface CredentialStore {
  /** Get a credential value by name. Returns null if not found. */
  get(name: string): string | null;

  /** Set a credential value. */
  set(name: string, value: string): void;

  /** Delete a credential. Returns true if it existed. */
  delete(name: string): boolean;

  /** List all credential names (not values). */
  list(): string[];
}

/**
 * Result of resolving credentials in text.
 */
export interface CredentialResolution {
  /** Text with placeholders replaced by real values */
  resolved: string;

  /** Names of credentials that were not found */
  missing: string[];
}

/**
 * Regex to match credential placeholders: <credential:name>
 * Name must be alphanumeric + underscores.
 */
const CREDENTIAL_PLACEHOLDER = /<credential:([a-zA-Z0-9_]+)>/g;

/**
 * Regex to match shell-style env var references: $NAME or ${NAME}
 * Only resolves names that exist in the credential store (not arbitrary env vars).
 */
const ENV_VAR_REFERENCE = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}|\$([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Create an env-var based credential store.
 *
 * Maps credential names to `VAULT_<NAME>` environment variables.
 * The name is uppercased and used as suffix: `api_key` → `VAULT_API_KEY`.
 */
export function createEnvCredentialStore(): CredentialStore {
  return {
    get(name: string): string | null {
      const envKey = `VAULT_${name.toUpperCase()}`;
      return process.env[envKey] ?? null;
    },

    set(name: string, value: string): void {
      const envKey = `VAULT_${name.toUpperCase()}`;
      process.env[envKey] = value;
    },

    delete(name: string): boolean {
      const envKey = `VAULT_${name.toUpperCase()}`;
      const existed = envKey in process.env;
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete process.env[envKey];
      return existed;
    },

    list(): string[] {
      const prefix = 'VAULT_';
      return Object.keys(process.env)
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length).toLowerCase());
    },
  };
}

/**
 * Resolve credential placeholders in text.
 *
 * Replaces `<credential:name>` with actual values from the store.
 * Returns the resolved text and any missing credential names.
 *
 * SAFETY: This must only be called immediately before tool execution.
 * The resolved text must NEVER be stored in conversation history or logs.
 */
export function resolveCredentials(text: string, store: CredentialStore): CredentialResolution {
  const missing: string[] = [];
  const knownNames = new Set(store.list().map((n) => n.toUpperCase()));

  // First pass: resolve <credential:NAME> placeholders
  let resolved = text.replace(CREDENTIAL_PLACEHOLDER, (_match, name: string) => {
    const value = store.get(name);
    if (value === null) {
      missing.push(name);
      return `<credential:${name}>`; // Leave placeholder if missing
    }
    return value;
  });

  // Second pass: resolve $NAME and ${NAME} references (only for known credentials)
  resolved = resolved.replace(
    ENV_VAR_REFERENCE,
    (match, braced: string | undefined, bare: string | undefined) => {
      const name = braced ?? bare;
      if (!name || !knownNames.has(name.toUpperCase())) return match; // Not a credential — leave as-is
      const value = store.get(name);
      if (value === null) {
        missing.push(name);
        return match;
      }
      return value;
    }
  );

  return { resolved, missing };
}

/**
 * Check if text contains any credential placeholders.
 */
export function hasCredentialPlaceholders(text: string): boolean {
  CREDENTIAL_PLACEHOLDER.lastIndex = 0;
  return CREDENTIAL_PLACEHOLDER.test(text);
}
