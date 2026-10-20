#!/usr/bin/env node
// Whether this machine's tracker store holds a recording of <rev>: exit 0 yes,
// 1 no, 2 cannot tell (no store, or <rev> is not a commit). The pre-push hook
// asks it before CI asks the same of the store ref (docs/backlog-integration.md).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { storeDir } from './adapter.mjs';

try {
  const rev = process.argv[2];
  const r = spawnSync('git', ['rev-parse', '-q', '--verify', `${rev}^{commit}`], { encoding: 'utf8' });
  if (!rev || r.status !== 0) throw new Error(`${rev || '(none)'} is not a commit`);
  process.exitCode = existsSync(join(storeDir(), '.tracker-sync', 'recordings', `${r.stdout.trim()}.jsonl`)) ? 0 : 1;
} catch (e) {
  console.error(`recorded.mjs: ${e.message}`);
  process.exitCode = 2;
}
