import { describe, expect, it } from 'vitest';
import { formatInstanceProofFailure } from '../integration/helpers/instance-proof-failure.js';

function errorWithStack(stack: unknown): Error {
  const error = new Error('synthetic-message-secret');
  Object.defineProperty(error, 'stack', { value: stack, configurable: true });
  return error;
}

describe('instance proof public failure diagnostics', () => {
  it('preserves checkpoints and numeric frames in a pure deliberate-failure loop', () => {
    const stages = {
      S7: [
        'originalinspect', 'panic', 'snapshotbefore', 'remove', 'create',
        'loaderready', 'inspectreplacement', 'comparefingerprints',
        'password', 'resume', 'settings', 'modelhold', 'receipt', 'sendack',
      ],
      S6: [
        'initial', 'panic', 'fingerprint', 'restart', 'daemonready',
        'recovery', 'password', 'resume',
      ],
    } as const;

    const secrets = [
      'synthetic-secret-credential',
      '?query=synthetic-query-secret',
      'Cookie: lm_session=synthetic-cookie-secret',
      '/private/synthetic-path-secret',
      'synthetic-config-secret',
      'synthetic-header-secret',
      'synthetic-body-secret',
      'synthetic-stdout-secret',
      'synthetic-stderr-secret',
      'synthetic-cause-secret',
    ];

    for (const proofCase of ['S7', 'S6'] as const) {
      for (const checkpoint of stages[proofCase]) {
        let diagnostic = '';
        try {
          const error = new Error(secrets.join(' '));
          Object.defineProperty(error, 'stack', {
            value: [
              `Error: ${secrets.join(' ')}`,
              `    at synthetic-secret-function (/private/synthetic-path-secret/instance-first-start.test.ts:321:9)`,
              `    at synthetic-secret-function (/private/synthetic-path-secret/instance-stable-snapshot.ts:77:4)`,
              `    at other (/private/synthetic-path-secret/other.ts:12:3)`,
              `    at query (/private/instance-first-start.test.ts?query=synthetic-query-secret:22:3)`,
            ].join('\n'),
          });
          for (const property of ['cause', 'stdout', 'stderr', 'config', 'headers', 'body']) {
            Object.defineProperty(error, property, {
              get() {
                throw new Error('synthetic-forbidden-property-secret');
              },
            });
          }
          throw error;
        } catch (error) {
          diagnostic = formatInstanceProofFailure(proofCase, checkpoint, error);
        }

        expect(diagnostic).toBe(
          `instance-proof-failure case=${proofCase} checkpoint=${checkpoint} ` +
          'frames=instance-first-start.test.ts:321:9,instance-stable-snapshot.ts:77:4',
        );
        for (const secret of secrets) {
          expect(diagnostic.includes(secret)).toBe(false);
        }
        expect(diagnostic.includes('synthetic-secret-function')).toBe(false);
      }
    }
  });

  it('does not read message or cause', () => {
    const error = errorWithStack(
      '    at proof (/private/instance-first-start.test.ts:8:2)',
    );
    for (const property of ['message', 'cause']) {
      Object.defineProperty(error, property, {
        get() {
          throw new Error('synthetic-getter-secret');
        },
      });
    }
    expect(formatInstanceProofFailure('S7', 'create', error)).toBe(
      'instance-proof-failure case=S7 checkpoint=create ' +
      'frames=instance-first-start.test.ts:8:2',
    );
  });

  it('handles a throwing stack getter', () => {
    const error = new Error('synthetic-secret');
    Object.defineProperty(error, 'stack', {
      get() {
        throw new Error('synthetic-stack-getter-secret');
      },
    });
    expect(formatInstanceProofFailure('S6', 'initial', error)).toBe(
      'instance-proof-failure case=S6 checkpoint=initial frames=none',
    );
  });

  it('rejects invalid cases and checkpoints without coercion', () => {
    const hostile = {
      toString() {
        throw new Error('synthetic-coercion-secret');
      },
    };
    for (const badCase of ['S8', 'S7 synthetic-secret', null, 7, hostile]) {
      expect(formatInstanceProofFailure(badCase, 'panic', undefined)).toBe(
        'instance-proof-failure case=unknown checkpoint=unknown frames=none',
      );
    }
    for (const checkpoint of ['create', 'synthetic-secret', null, hostile]) {
      expect(formatInstanceProofFailure('S6', checkpoint, undefined)).toBe(
        'instance-proof-failure case=S6 checkpoint=unknown frames=none',
      );
    }
    expect(formatInstanceProofFailure('S7', 'initial', undefined)).toBe(
      'instance-proof-failure case=S7 checkpoint=unknown frames=none',
    );
  });

  it('does not read stack properties on non-Errors', () => {
    let reads = 0;
    const object = {
      get stack() {
        reads++;
        throw new Error('synthetic-object-secret');
      },
    };
    for (const value of [undefined, null, false, 1, 'synthetic-secret', object]) {
      expect(formatInstanceProofFailure('S6', 'initial', value)).toBe(
        'instance-proof-failure case=S6 checkpoint=initial frames=none',
      );
    }
    expect(reads).toBe(0);

    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    expect(formatInstanceProofFailure('S6', 'initial', revocable.proxy)).toBe(
      'instance-proof-failure case=S6 checkpoint=initial frames=none',
    );
  });

  it('rejects non-string and oversized stacks, including UTF-8 overflow', () => {
    const frame = '\n    at proof (/private/instance-first-start.test.ts:1:1)';
    for (const stack of [
      undefined,
      {},
      'x'.repeat(65_537),
      'x'.repeat(65_537) + frame,
      'é'.repeat(32_769) + frame,
      '😀'.repeat(16_385) + frame,
    ]) {
      expect(formatInstanceProofFailure('S7', 'panic', errorWithStack(stack))).toBe(
        'instance-proof-failure case=S7 checkpoint=panic frames=none',
      );
    }

    const exactBound = 'x'.repeat(65_536 - frame.length) + frame;
    expect(formatInstanceProofFailure('S7', 'panic', errorWithStack(exactBound))).toBe(
      'instance-proof-failure case=S7 checkpoint=panic ' +
      'frames=instance-first-start.test.ts:1:1',
    );
  });

  it('requires exact filenames, terminal coordinates, and bounded positive numbers', () => {
    const stack = [
      'Error: instance-first-start.test.ts:88:8 synthetic-secret',
      '    at f (/private/not-instance-first-start.test.ts:1:1)',
      '    at f (/private/instance-first-start.test.ts.bak:1:1)',
      '    at f (/private/instance-first-start.test.ts?secret=query:1:1)',
      '    at f (/private/instance-first-start.test.ts:1:1?secret=query)',
      '    at f (/private/instance-first-start.test.ts:0:1)',
      '    at f (/private/instance-first-start.test.ts:1:0)',
      '    at f (/private/instance-first-start.test.ts:10001:1)',
      '    at f (/private/instance-first-start.test.ts:1:10001)',
      '    at f (/private/instance-first-start.test.ts:100000:1)',
      '    at f (/private/instance-first-start.test.ts:-1:1)',
      '    at f (/private/instance-first-start.test.ts:1.5:1)',
      '    at f (/private/instance-first-start.test.ts:10000:10000)',
      '    at C:\\private\\instance-stable-snapshot.ts:1:1',
    ].join('\n');

    expect(formatInstanceProofFailure('S7', 'snapshotbefore', errorWithStack(stack))).toBe(
      'instance-proof-failure case=S7 checkpoint=snapshotbefore ' +
      'frames=instance-first-start.test.ts:10000:10000,instance-stable-snapshot.ts:1:1',
    );
  });

  it('emits at most three frames', () => {
    const stack = [1, 2, 3, 4, 5].map(line =>
      `    at synthetic-secret (/private/instance-first-start.test.ts:${line}:2)`,
    ).join('\n');
    expect(formatInstanceProofFailure('S6', 'fingerprint', errorWithStack(stack))).toBe(
      'instance-proof-failure case=S6 checkpoint=fingerprint ' +
      'frames=instance-first-start.test.ts:1:2,' +
      'instance-first-start.test.ts:2:2,instance-first-start.test.ts:3:2',
    );
  });
});
