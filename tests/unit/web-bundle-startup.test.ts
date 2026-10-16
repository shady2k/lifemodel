import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const entry = fileURLToPath(new URL('../../src/web/index.ts', import.meta.url));

describe('built web server artifact', () => {
  it('starts through module loading and reaches store connection with required environment', async () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts['build:web-server']).toContain('--format=cjs');
    expect(manifest.scripts['build:web-server']).toContain('server.cjs');
    const dockerfile = readFileSync(
      new URL('../../docker/web/Dockerfile', import.meta.url),
      'utf8'
    );
    expect(dockerfile).toContain('dist/web/server.cjs');
    expect(dockerfile).toContain('CMD [\"node\", \"dist/web/server.cjs\"]');
    const directory = await mkdtemp(join(tmpdir(), 'web-server-bundle-'));
    try {
      const output = join(directory, 'server.cjs');
      await build({
        entryPoints: [entry],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        outfile: output,
      });
      const app = join(directory, 'app');
      await mkdir(app);
      await writeFile(join(app, 'index.html'), '<html></html>');
      const child = spawn(process.execPath, [output], {
        env: {
          ...process.env,
          LIFEMODEL_WEB_ALLOWED_ORIGIN: 'https://lifemodel.local',
          LIFEMODEL_NAME: 'lifemodel',
          LIFEMODEL_WEB_APP_DIRECTORY: app,
          LIFEMODEL_WEB_PORT: '18080',
          LIFEMODEL_WEB_INTERNAL_PORT: '18081',
          LIFEMODEL_VALKEY_URL: 'redis://127.0.0.1:1',
          LIFEMODEL_DATABASE_URL: 'postgres://user:pass@127.0.0.1:1/db',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderr += chunk;
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const deadline = setTimeout(
            () => reject(new Error(`server did not attempt stores: ${stdout} ${stderr}`)),
            10_000
          );
          child.once('error', reject);
          child.once('exit', (code) => {
            clearTimeout(deadline);
            reject(new Error(`server exited before listen (${code}): ${stdout} ${stderr}`));
          });
          child.stdout.on('data', () => {
            if (stdout.includes('Web server listening')) {
              clearTimeout(deadline);
              resolve();
            }
          });
        });
        const response = await fetch('http://127.0.0.1:18081/readyz');
        expect(response.status).toBe(503);
        expect((await response.json()).ready).toBe(false);
      } finally {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
