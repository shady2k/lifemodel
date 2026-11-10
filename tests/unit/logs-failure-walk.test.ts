/** WALK-LOGS-FAILURE (ADR-016 L03, L04, §9 points 3-6): the walk is an
 * operator script for a deployed build, so these checks hold its contract and
 * its decisions against the fake node in
 * `tests/fixtures/logs-failure-walk-harness.py`: the failure record found by
 * minute and conversation, the marker absent from the store and only in the
 * capture, and the final gateway record's level in the four cases.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const WALK = join('deploy', 'platform', 'logs-failure-walk.py');
const HARNESS = join('tests', 'fixtures', 'logs-failure-walk-harness.py');

interface Run {
  readonly status: number | null;
  readonly lines: readonly string[];
  readonly failures: readonly string[];
  readonly passes: readonly string[];
  readonly notes: readonly string[];
  readonly invalid: readonly string[];
}

function python(args: readonly string[]): Run {
  const result = spawnSync('python3', args, { encoding: 'utf8' });
  expect(result.error).toBeUndefined();
  const lines = result.stdout.split('\n');
  return {
    status: result.status,
    lines,
    failures: lines.filter((line) => line.startsWith('FAIL ')),
    passes: lines.filter((line) => line.startsWith('PASS ')),
    notes: lines.filter((line) => line.startsWith('NOTE ')),
    invalid: lines.filter((line) => line.startsWith('TEST NOT VALID')),
  };
}

function jsonLine<T>(run: Run, prefix: string): T {
  const line = run.lines.find((entry) => entry.startsWith(prefix + ' '));
  expect(line).toBeDefined();
  return JSON.parse((line ?? '').slice(prefix.length + 1)) as T;
}

let directory = '';

function harness(mode: string): Run {
  const fixture = join(directory, mode + '.json');
  writeFileSync(fixture, '{}');
  return python([HARNESS, mode, WALK, fixture]);
}

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'logs-failure-walk-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('the failure walk\'s argument handling', () => {
  it('prints its usage and exits 0 on --help', () => {
    const run = python([WALK, '--help']);
    expect(run.status).toBe(0);
    const help = run.lines.join('\n');
    for (const name of [
      '--password-file',
      '--web-host',
      '--stub-namespace',
      '--stub-port',
      '--node-address',
      '--gateway',
      '--doctor-command',
      '--found-bound',
      '--restart-bound',
    ]) {
      expect(help).toContain(name);
    }
  });

  it('refuses an unknown argument and a missing password file', () => {
    expect(python([WALK, '--no-such-argument']).status).toBe(2);
    expect(python([WALK]).status).toBe(2);
  });
});

describe('the failure walk states what it proves and how', () => {
  it('names its walk, its rows, and the stub placement the policy forces', () => {
    const header = readFileSync(WALK, 'utf8').split('\n').slice(0, 240).join('\n');
    expect(header).toContain('WALK-LOGS-FAILURE');
    expect(header).toMatch(/ADR-016 L03, L04/);
    expect(header).toMatch(/conversation_id/);
    expect(header).toMatch(/error_type/);
    expect(header).toMatch(/reason_check/);
    expect(header).toMatch(/host-network pod/);
    expect(header).toMatch(/What it does not cover/);
  });

  it('finds the record through the loader API, never with kubectl', () => {
    const source = readFileSync(WALK, 'utf8');
    const finding = source.slice(source.indexOf('def records_in_window'),
                                 source.indexOf('def field_of'));
    expect(finding).toContain('loader.logs');
    expect(finding).not.toContain('kubectl');
    expect(source).toMatch(/RESTORE/);
    expect(source).toMatch(/finally:/);
  });

  it('never prints a credential or a settings dump', () => {
    const source = readFileSync(WALK, 'utf8');
    expect(source).not.toMatch(/print\([^)]*secret/);
    // No key or header value is read at all: the views carry names, not values.
    expect(source).not.toMatch(/slot\.get\('key'\)/);
    expect(source).not.toMatch(/headerNames.*\bvalue\b/);
    expect(source).toContain("'/api/model'");
  });
});

describe('a fake node for the failure walk', () => {
  it('names the chat URL and the exception type when the send never answers', () => {
    const run = harness('chat-unreachable');
    const value = jsonLine<{ accepted: boolean; detail: string }>(run, 'CHAT');
    expect(value.accepted).toBe(false);
    expect(value.detail).toContain('http://127.0.0.1:');
    expect(value.detail).toContain('/api/messages');
    expect(value.detail).toContain('ConnectionRefusedError');
    expect(value.detail).not.toContain('cookie');
  }, 30000);

  it('waits for the gateway to serve a slot change before a case runs', () => {
    const pass = harness('slots-live-pass');
    expect(jsonLine<boolean>(pass, 'LIVE')).toBe(true);
    expect(pass.passes.join('\n')).toContain('the gateway serves the new slots');
    const stale = harness('slots-live-stale');
    expect(jsonLine<boolean>(stale, 'LIVE')).toBe(false);
    expect(stale.failures.join('\n')).toContain('the gateway serves the new slots');
    expect(stale.invalid.join('\n')).toContain('the new slots never served');
  }, 60000);

  it('judges the capture on the API\'s own answer after every PUT', () => {
    const run = harness('capture-readback');
    const values = run.lines
      .filter((line) => line.startsWith('CAPTURE '))
      .map((line) => JSON.parse(line.slice(8)) as { off: boolean; on: boolean });
    expect(values[0]).toEqual({ off: true, on: false });
    expect(values[1]).toEqual({ off: false, on: false });
  }, 30000);

  it('clears the reserve with a JSON body and content type', () => {
    const run = harness('delete-reserve');
    const value = jsonLine<{
      status: number;
      request: { method: string; path: string; body: string; headers: Record<string, string> };
    }>(run, 'DELETE');
    expect(value.status).toBe(200);
    expect(value.request.method).toBe('DELETE');
    expect(value.request.path).toBe('/api/model/reserve');
    expect(value.request.body).toBe('{}');
    expect(value.request.headers['content-type']).toBe('application/json');
  }, 30000);

  it('compares the restored slots by model, host and key flag only', () => {
    const run = harness('restore-compare');
    const value = jsonLine<{ same: string[]; changed: string[] }>(run, 'COMPARE');
    expect(value.same).toEqual([]);
    expect(value.changed).toHaveLength(2);
    expect(value.changed[0]).toContain('model');
    expect(value.changed[1]).toContain('reserve');
  }, 30000);

  it('passes the failure verdict when the record carries type and conversation', () => {
    const run = harness('verdict-failure-pass');
    expect(jsonLine<boolean>(run, 'VERDICT')).toBe(true);
    expect(run.status).toBe(0);
  }, 30000);

  it('fails the failure verdict without an error_type', () => {
    const run = harness('verdict-failure-no-type');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain('no error_type');
  }, 30000);

  it('fails the failure verdict when no core line carries the conversation', () => {
    const run = harness('verdict-failure-no-core');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain('no core line carries the conversation_id');
  }, 30000);

  it('passes a marker absent from the store and present in the capture', () => {
    const run = harness('verdict-marker-pass');
    expect(jsonLine<{ ok: boolean }>(run, 'VERDICT').ok).toBe(true);
  }, 30000);

  it('fails a marker found in the store', () => {
    const run = harness('verdict-marker-in-store');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain('found in the store');
  }, 30000);

  it('fails a marker absent from the capture', () => {
    const run = harness('verdict-marker-no-capture');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain('not found in the exchange capture');
  }, 30000);

  it('passes the four level cases on their final records', () => {
    const run = harness('verdict-levels');
    expect(jsonLine<Record<string, boolean>>(run, 'LEVELS')).toEqual({
      error: true,
      'no-retry': true,
      warn: true,
      terminal: true,
    });
  }, 30000);

  it('fails a non-retryable 400 that was retried on the reserve', () => {
    const run = harness('verdict-level-retried-400');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain('the reserve never contacted');
  }, 30000);

  it('fails a retried attempt that also left a terminal error', () => {
    const run = harness('verdict-level-warn-with-error');
    const value = jsonLine<{ ok: boolean; detail: string }>(run, 'VERDICT');
    expect(value.ok).toBe(false);
    expect(value.detail).toContain('one level=warn and no level=error');
  }, 30000);

  it('drives the four cases through the slots, the gateway and the API', () => {
    const run = harness('case-levels-wiring');
    expect(run.passes.join('\n')).toContain('primary 400 with a reserve ends error and never retries');
    expect(run.passes.join('\n')).toContain('a reserve that succeeds gives one warn');
    expect(run.failures).toEqual([]);
    expect(jsonLine<string[]>(run, 'SESSIONS')).toHaveLength(4);
  }, 60000);

  it('expects the reserve that succeeds to answer 200', () => {
    const run = harness('level-success-status');
    expect(run.passes.join('\n')).toContain('a reserve that succeeds gives one warn with a model answer');
    expect(run.failures).toEqual([]);
    expect(run.status).toBe(0);
  }, 60000);

  it('fails the same case when the reserve that succeeds answers 500', () => {
    const run = harness('level-success-wrong');
    expect(run.failures.join('\n')).toContain(
      'a reserve that succeeds gives one warn with a model answer',
    );
    expect(run.status).toBe(1);
  }, 60000);
});
