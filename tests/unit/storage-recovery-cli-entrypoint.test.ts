/** The packaged recovery executable owns pipe failures and argument rejection. */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
const entrypoint = fileURLToPath(
  new URL('../../loader/src/storage-recovery-cli.ts', import.meta.url)
);
async function run(args: string[], closed: ('stdout' | 'stderr')[] = []) {
  const child = spawn(process.execPath, ['--import', 'tsx', entrypoint, ...args], {
    env: {},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '',
    timedOut = false;
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  child.stdout.on('data', (part: Buffer) => {
    stdout += part.toString();
  });
  child.stderr.on('data', (part: Buffer) => {
    stderr += part.toString();
  });
  for (const name of closed) child[name].destroy();
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 5000);
  const result = await new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.on('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    }
  ).finally(() => clearTimeout(timer));
  return { ...result, stdout, stderr, timedOut };
}
describe('recovery executable', () => {
  it('runs help without credentials and rejects inherited command names safely', async () => {
    expect(await run(['help'])).toMatchObject({
      code: 0,
      signal: null,
      timedOut: false,
      stderr: '',
    });
    for (const command of ['constructor', '__proto__', 'toString']) {
      const result = await run([command]);
      expect(result).toMatchObject({ code: 2, signal: null, timedOut: false, stdout: '' });
      expect(JSON.parse(result.stderr)).toMatchObject({ code: 'invalid_arguments' });
    }
  });
  it.each([['stdout'], ['stdout', 'stderr']] as ('stdout' | 'stderr')[][])(
    'fails boundedly with closed output %j',
    async (...names) => {
      const result = await run(['help'], names);
      expect(result).toMatchObject({ code: 1, signal: null, timedOut: false, stdout: '' });
      expect(result.stderr).not.toMatch(/Unhandled|Error:|\n\s+at |EPIPE/);
    }
  );
  it('owns failure of the diagnostic pipe too', async () => {
    expect(await run(['invalid'], ['stderr'])).toMatchObject({
      code: 1,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
    });
  });
});
