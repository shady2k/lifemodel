#!/usr/bin/env node
// What a worker may take now, in one stage and one checkout. `br ready` alone is
// not this: it never releases a dependant whose prerequisite is `implemented`
// and merged here, since br releases only on close.
//
//   ready.mjs [--stage <id>] [--checkout <rev>]   (checkout defaults to HEAD)
//
// Ready = an open, unheld leaf whose every prerequisite is
//   - closed; or
//   - implemented in the SAME stage, its recorded revision already in the
//     checkout; or
//   - implemented in an EARLIER stage of the same feature whose acceptance is
//     recorded (`accepted: <rev> -- <evidence>` on the stage), the accepted
//     revision already in the checkout - the stage stays open until it lands.
// A prerequisite in another feature waits for closure. Deferred work and ideas
// are never ready.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { read } from './adapter.mjs';

/** The feature an issue belongs to: the root of its parent chain. */
function featureOf(by, issue) {
  let at = issue;
  const seen = new Set();
  while (at.parent && by.has(at.parent) && !seen.has(at.id)) {
    seen.add(at.id);
    at = by.get(at.parent);
  }
  return at.id;
}

/**
 * The ready leaves of a normalized backlog. `merged(rev)` says whether a
 * recorded revision is contained in the checkout.
 */
export function readyLeaves(issues, { stage = null, merged }) {
  const by = new Map(issues.map((i) => [i.id, i]));
  const hasLiveChild = new Set(
    issues.filter((i) => i.parent && !['closed', 'deferred'].includes(i.status)).map((i) => i.parent),
  );
  const satisfied = (leaf, dep) => {
    const d = by.get(dep);
    if (!d) return false;
    if (d.status === 'closed') return true;
    if (d.status !== 'implemented') return false;
    if (d.parent && d.parent === leaf.parent) return merged(d.integration?.revision);
    const dStage = by.get(d.parent);
    return (
      Boolean(dStage?.acceptance?.revision) &&
      featureOf(by, d) === featureOf(by, leaf) &&
      merged(dStage.acceptance.revision)
    );
  };
  return issues.filter(
    (i) =>
      i.status === 'open' &&
      !i.holder &&
      i.type !== 'epic' &&
      !hasLiveChild.has(i.id) &&
      !(i.labels || []).includes('idea') &&
      (!stage || i.parent === stage) &&
      i.blockedBy.every((d) => satisfied(i, d)),
  );
}

function main() {
  const argv = process.argv.slice(2);
  const opt = (k) => (argv.indexOf(k) >= 0 ? argv[argv.indexOf(k) + 1] : null);
  const checkout = opt('--checkout') || 'HEAD';
  const merged = (rev) => {
    // A recorded revision may be written `branch@sha`; the commit is what counts.
    const sha = String(rev || '').split('@').pop();
    if (!sha) return false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', sha, checkout], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };
  const { issues } = read([]);
  for (const i of readyLeaves(issues, { stage: opt('--stage'), merged })) console.log(`${i.id}\t${i.title}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
