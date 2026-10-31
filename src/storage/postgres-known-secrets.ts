/** Include both URL-encoded and decoded credentials in disposable text redaction. */
export function postgresKnownSecrets(databaseUrl: string): string[] {
  const password = new URL(databaseUrl).password;
  return [...new Set([databaseUrl, password, decodeURIComponent(password)].filter(Boolean))];
}
