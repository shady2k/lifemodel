/**
 * Pure public diagnostics. No imports, native I/O, or import-time work.
 * Never retain or emit an error, stack text, or caller-supplied string.
 */

type Checkpoints = {
  S7:
    | 'originalinspect'
    | 'panic'
    | 'snapshotbefore'
    | 'remove'
    | 'create'
    | 'loaderready'
    | 'inspectreplacement'
    | 'comparefingerprints'
    | 'password'
    | 'resume'
    | 'settings'
    | 'modelhold'
    | 'receipt'
    | 'sendack';
  S6:
    | 'initial'
    | 'panic'
    | 'fingerprint'
    | 'restart'
    | 'daemonready'
    | 'recovery'
    | 'password'
    | 'resume';
};

export type InstanceProofCheckpoint<C extends keyof Checkpoints> = Checkpoints[C];

function publicCase(value: unknown): 'S7' | 'S6' | 'unknown' {
  if (value === 'S7') return 'S7';
  if (value === 'S6') return 'S6';
  return 'unknown';
}

/** Literal returns ensure that no arbitrary input string reaches output. */
function publicCheckpoint(
  proofCase: 'S7' | 'S6' | 'unknown',
  value: unknown,
): string {
  if (proofCase === 'S7') {
    switch (value) {
      case 'originalinspect': return 'originalinspect';
      case 'panic': return 'panic';
      case 'snapshotbefore': return 'snapshotbefore';
      case 'remove': return 'remove';
      case 'create': return 'create';
      case 'loaderready': return 'loaderready';
      case 'inspectreplacement': return 'inspectreplacement';
      case 'comparefingerprints': return 'comparefingerprints';
      case 'password': return 'password';
      case 'resume': return 'resume';
      case 'settings': return 'settings';
      case 'modelhold': return 'modelhold';
      case 'receipt': return 'receipt';
      case 'sendack': return 'sendack';
    }
  }
  if (proofCase === 'S6') {
    switch (value) {
      case 'initial': return 'initial';
      case 'panic': return 'panic';
      case 'fingerprint': return 'fingerprint';
      case 'restart': return 'restart';
      case 'daemonready': return 'daemonready';
      case 'recovery': return 'recovery';
      case 'password': return 'password';
      case 'resume': return 'resume';
    }
  }
  return 'unknown';
}

/** UTF-8 size check without Buffer, TextEncoder, or native dependencies. */
function boundedStack(error: unknown): string | undefined {
  try {
    if (!(error instanceof Error)) return undefined;
    const stack: unknown = error.stack;
    if (typeof stack !== 'string' || stack.length > 65_536) return undefined;

    let bytes = 0;
    for (let i = 0; i < stack.length; i++) {
      const code = stack.charCodeAt(i);
      if (code <= 0x7f) {
        bytes++;
      } else if (code <= 0x7ff) {
        bytes += 2;
      } else if (
        code >= 0xd800 && code <= 0xdbff &&
        i + 1 < stack.length &&
        stack.charCodeAt(i + 1) >= 0xdc00 &&
        stack.charCodeAt(i + 1) <= 0xdfff
      ) {
        bytes += 4;
        i++;
      } else {
        bytes += 3;
      }
      if (bytes > 65_536) return undefined;
    }
    return stack;
  } catch {
    // Includes throwing stack getters and revoked proxies.
    return undefined;
  }
}

function publicFrames(error: unknown): string {
  const stack = boundedStack(error);
  if (stack === undefined) return 'none';

  const frames: string[] = [];
  for (const line of stack.split('\n')) {
    // Only V8-style frame lines. Ignore the error heading and message.
    if (!/^\s+at\s/.test(line)) continue;

    // A complete basename and terminal line:column are mandatory.
    // Paths, function names, and other frame content are never copied.
    const match =
      /(?:^|[\\/(\s])(instance-first-start\.test\.ts|instance-stable-snapshot\.ts):([0-9]{1,5}):([0-9]{1,5})\)?\r?$/.exec(line);
    if (match === null) continue;

    const lineNumber = Number(match[2]);
    const columnNumber = Number(match[3]);
    if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > 10_000 ||
        !Number.isInteger(columnNumber) || columnNumber < 1 || columnNumber > 10_000) {
      continue;
    }

    const source = match[1] === 'instance-first-start.test.ts'
      ? 'instance-first-start.test.ts'
      : 'instance-stable-snapshot.ts';
    frames.push(`${source}:${lineNumber}:${columnNumber}`);
    if (frames.length === 3) break;
  }
  return frames.length === 0 ? 'none' : frames.join(',');
}

export function formatInstanceProofFailure(
  proofCase: unknown,
  checkpoint: unknown,
  error: unknown,
): string {
  const label = publicCase(proofCase);
  return `instance-proof-failure case=${label} ` +
    `checkpoint=${publicCheckpoint(label, checkpoint)} ` +
    `frames=${publicFrames(error)}`;
}
