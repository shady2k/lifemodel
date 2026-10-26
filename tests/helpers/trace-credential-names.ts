/** Opaque values deliberately lack shaped-token prefixes. */
export function credentialNameCases(boundary: string) {
  const names = [
    'DATABASE_PASSWORD',
    'SERVICE_TOKEN',
    'AWS_SECRET_ACCESS_KEY',
    'MY-API-KEY',
    'db.password',
    'passwd_backup',
    'credential.cache',
    'service.access_key',
    'database_password_hash',
    'TOKEN_SUFFIX',
  ];
  const canaries: string[] = [];
  const content = names
    .flatMap((name, i) => {
      return ['unquoted', 'single', 'double', 'json', 'nested'].map((form, j) => {
        const value = `opaque-${boundary}-${i}-${j}-a19c`;
        canaries.push(value);
        if (form === 'single') return `${name}='${value} with spaces'`;
        if (form === 'double') return `${name}="${value} with spaces"`;
        if (form === 'json') return JSON.stringify({ [name]: value });
        if (form === 'nested') return JSON.stringify(JSON.stringify({ [name]: value }));
        return `${name}=${value}`;
      });
    })
    .join('\n');
  const structured = Object.fromEntries(
    names.map((name, i) => {
      const value = `opaque-${boundary}-structured-${i}-a19c`;
      canaries.push(value);
      return [name, value];
    })
  );
  return {
    canaries,
    attrs: {
      command: content,
      outputTail: content,
      finalText: content,
      model: content,
      structured,
      ordinary: 'tokenizer=bpe secretary: x',
    },
  };
}
