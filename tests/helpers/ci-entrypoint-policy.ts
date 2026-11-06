// Deliberately not a general YAML parser. Unsupported layouts fail closed.
const clean = (text: string): string =>
  text
    .split('\n')
    .filter((line) => line.trim() && !line.trimStart().startsWith('#'))
    .map((line) => line.trimEnd())
    .join('\n');

const header = `name: CI
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [main]
permissions:
  contents: read`;

export function ciEntrypointPolicy(source: string): void {
  const fail = (reason: string): never => {
    throw new Error(`CI entrypoint policy: ${reason}`);
  };
  const lines = clean(source).split('\n');
  const start = lines.indexOf('jobs:');
  if (start < 0 || lines.slice(0, start).join('\n') !== header) {
    fail('unsupported workflow header or inherited authority');
  }
  const jobs = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    const job = /^  ([a-z][a-z0-9-]*):$/.exec(line);
    if (job) {
      if (jobs.has(job[1])) fail('duplicate job');
      current = [];
      jobs.set(job[1], current);
    } else {
      if (!current || !/^ {4}\S|^ {5,}\S/.test(line)) fail('unsupported job layout');
      current.push(line);
    }
  }
  for (const required of [
    'ci-product',
    'ci-backlog',
    'ci-core-image',
    'ci-core-image-publish',
    'ci-workbench-image-publish',
  ]) {
    if (!jobs.has(required)) fail(`missing ${required}`);
  }
  for (const [name, body] of jobs) {
    const commands: string[] = [];
    for (let i = 0; i < body.length; i++) {
      const line = body[i];
      // Quoted (including escaped) keys and flow mappings are unsupported.
      // Reject them before scanning so hidden run keys cannot be skipped.
      if (/^ +(?:-\s*)?(?:["']|(?:[\w-]+:\s*)?\{)/.test(line)) {
        fail(`${name}: unsupported mapping layout`);
      }
      // Reject YAML indirection and alternative step/run layouts.
      if (/^ +(?:-\s*)?[^#]*:\s*[&*!]/.test(line)) fail(`${name}: YAML indirection`);
      if (!/\brun\s*:/.test(line)) continue;
      const run = /^        run: (.+)$/.exec(line);
      if (!run) fail(`${name}: unsupported run layout`);
      if (run[1] === '|') {
        const block: string[] = [];
        while (i + 1 < body.length && /^ {10}\S|^ {11,}\S/.test(body[i + 1])) {
          block.push(body[++i].slice(10));
        }
        if (!block.length) fail(`${name}: empty run block`);
        commands.push(block.join('\n'));
      } else {
        if (/^[|>'"]/.test(run[1])) fail(`${name}: unsupported run scalar`);
        commands.push(run[1]);
      }
    }
    for (const command of commands) {
      // Strict by design: no npm tokens or ordinary suites outside the isolated boundary,
      // including flagged commands and literal quoted executables.
      if (/\b(?:vitest|npm)\b/.test(command)) {
        fail(`${name}: host install or ordinary suite`);
      }
    }
    if (name === 'ci-product') {
      if (
        !body
          .join('\n')
          .includes(
            "      - uses: actions/setup-node@v7\n        with:\n          node-version: '24'"
          )
      )
        fail('product must use Node 24');
      // This one required job holds the full check and, on a pull request, the
      // repetition of its new and changed test files (lifemodel-hbsi). Both go
      // through the launcher, in that order; nothing else runs here.
      if (commands[0] !== 'node scripts/test-isolated.mjs check') {
        fail('product must run the isolated check first');
      }
      if (
        commands.length !== 2 ||
        !commands[1].includes('node scripts/test-isolated.mjs repeat --')
      ) {
        fail('product must repeat changed test files through the isolated launcher');
      }
      if (!body.join('\n').includes("        if: ${{ github.event_name == 'pull_request' }}")) {
        fail('product must repeat test files on pull requests only');
      }
      // Job-level execution overrides are unsupported. A step-level `env:` is
      // how the jobs pass an expression to a step, and is allowed.
      if (body.some((line) => /^ {4}(?:env|container|services|defaults):/.test(line))) {
        fail('unsupported product execution override');
      }
    }
  }
}
