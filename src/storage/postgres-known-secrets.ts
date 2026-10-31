import { parse } from 'pg-connection-string';

/** Include pg's decoded password and, when available, the raw userinfo password. */
export function postgresKnownSecrets(databaseUrl: string): string[] {
  try {
    const password = parse(databaseUrl).password;
    let rawPassword = '';
    try {
      rawPassword = new URL(databaseUrl).password;
    } catch {
      // pg also accepts socket paths and URLs without a host.
    }
    return [
      ...new Set([databaseUrl, password, rawPassword].filter((value): value is string => !!value)),
    ];
  } catch {
    // Redaction must never break startup or expose a parser error's URL input.
    return [databaseUrl];
  }
}
