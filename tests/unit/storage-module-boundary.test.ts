import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(root, e.name)) : e.name.endsWith('.ts') ? [join(root, e.name)] : []
  );
}
describe('storage credential boundary', () => {
  it('contains every S3 or signing import inside platform storage-module files', () => {
    const bad: string[] = [];
    for (const path of [...files('src'), ...files('loader/src'), ...files('web')]) {
      const text = readFileSync(path, 'utf8');
      const moduleFile = [
        'storage-access.ts',
        'storage-access-error.ts',
        'storage-catalog.ts',
        'storage-custody.ts',
        'storage-health.ts',
        'storage-identity.ts',
        'storage-module.ts',
        'storage-module-app.ts',
        'storage-object-s3.ts',
        'storage-objects.ts',
        'storage-s3.ts',
        'storage-seal.ts',
        'storage-retention.ts',
        'storage-expired-uploads.ts',
        'storage-restore-reconcile.ts',
      ].some((name) => path === `loader/src/${name}`);
      const imports = [
        ...text.matchAll(/(?:from\s*|import\s*\(|require\s*\()(['"])([^'"\n]+)\1/g),
      ].map((m) => m[2]!);
      if (
        !moduleFile &&
        imports.some((name) =>
          /(?:aws-sdk|@aws-sdk|s3-request-presigner|aws4|smithy|storage-(?:s3|object-s3))/.test(
            name
          )
        )
      )
        bad.push(path);
      if (!moduleFile && /createHmac/.test(text) && /AWS4-HMAC-SHA256/.test(text)) bad.push(path);
    }
    expect(bad).toEqual([]);
  });
});
