/**
 * Tests for the sandbox-runner execFile refactor.
 *
 * Verifies the sandbox still works correctly after switching from
 * fork() + IPC to execFile() + stdout JSON.
 */

import { describe, it, expect } from 'vitest';
import { runSandbox } from '../../../src/runtime/sandbox/sandbox-runner.js';

describe('runSandbox (execFile refactor)', () => {
  it('evaluates simple expressions', async () => {
    const result = await runSandbox('2 + 2');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('4');
  });

  it('evaluates Math operations', async () => {
    const result = await runSandbox('Math.pow(2, 10)');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('1024');
  });

  it('evaluates JSON operations', async () => {
    const result = await runSandbox('JSON.stringify({ a: 1, b: 2 })');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('{"a":1,"b":2}');
  });

  it('returns execution errors for invalid code', async () => {
    const result = await runSandbox('throw new Error("test error")');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('execution_error');
  });

  it('rejects dangerous code via guard', async () => {
    const result = await runSandbox('require("fs").readFileSync("/etc/passwd")');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_args');
  });

  it('handles undefined results', async () => {
    const result = await runSandbox('undefined');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('(undefined)');
  });

  it('handles null results', async () => {
    const result = await runSandbox('null');
    expect(result.ok).toBe(true);
    expect(result.output).toBe('(null)');
  });

  it('handles multi-statement code', async () => {
    const result = await runSandbox('let x = 5; let y = 10;');
    expect(result.ok).toBe(true);
  });

  it('reports duration', async () => {
    const result = await runSandbox('1 + 1');
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('times out long-running code', async () => {
    const result = await runSandbox('while(true) {}', 500);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('timeout');
  }, 10_000);
});
