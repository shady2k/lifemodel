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
      // repetition of its new and changed test files (lifemodel-hbsi). The
      // whole selection shell is scripts/ci-repeat-changed-tests.sh; this job
      // pins exactly two commands, in that order.
      if (commands.length !== 2) {
        fail('product must run exactly the isolated check and the repeat script');
      }
      if (commands[0] !== 'node scripts/test-isolated.mjs check') {
        fail('product must run the isolated check first');
      }
      if (commands[1] !== 'scripts/ci-repeat-changed-tests.sh') {
        fail('product must repeat changed test files through scripts/ci-repeat-changed-tests.sh');
      }
      if (!body.join('\n').includes("        if: ${{ github.event_name == 'pull_request' }}")) {
        fail('product must repeat test files on pull requests only');
      }
      // Job-level execution overrides are unsupported.
      if (body.some((line) => /^ {4}(?:env|container|services|defaults):/.test(line))) {
        fail('unsupported product execution override');
      }
      // The repeat step may pass exactly the two expressions its script reads.
      // Any other step-level variable could hide host execution in a run line
      // (`HOST_SUITE: vitest run` beside `$HOST_SUITE`), which the run-command
      // rule never sees. No other step gets an environment at all.
      const repeatRun = body.findIndex(
        (line) => line === '        run: scripts/ci-repeat-changed-tests.sh'
      );
      let repeatStepStart = -1;
      for (let i = repeatRun - 1; i >= 0; i--) {
        if (/^ {6}- /.test(body[i])) {
          repeatStepStart = i;
          break;
        }
      }
      if (repeatStepStart < 0) fail('product repeat step has no supported layout');
      const envAt = body
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^\s+env:\s*$/.test(line));
      if (envAt.length !== 1) fail('product may pass only the repeat step its two expressions');
      const envIndex = envAt[0].index;
      const expectedEnv = [
        '        env:',
        '          BASE_REF: ${{ github.base_ref }}',
        '          HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
      ];
      if (
        envIndex < repeatStepStart ||
        body.slice(envIndex, envIndex + 3).join('\n') !== expectedEnv.join('\n') ||
        (body[envIndex + 3] !== undefined && /^ {10,}\S/.test(body[envIndex + 3]))
      ) {
        fail('unsupported product step environment');
      }
    }
  }
}
