/**
 * Unit tests for tool output truncation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import {
  truncateToolOutput,
  TRUNCATION_MAX_LINES,
  TRUNCATION_MAX_BYTES,
  TRUNCATION_DIR,
} from '../../../src/runtime/motor-cortex/tool-truncation.js';

describe('truncateToolOutput', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'truncation-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  describe('under-limit passthrough (non-fetch tools)', () => {
    it('returns original content when under both limits', async () => {
      const output = 'Hello, world!';
      const result = await truncateToolOutput(output, 'read', 'call_123', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
      expect(result.originalBytes).toBeUndefined();
      expect(result.savedPath).toBeUndefined();
    });

    it('returns original content at exactly max bytes (non-fetch)', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES);
      const result = await truncateToolOutput(output, 'bash', 'call_abc', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
    });

    it('returns original content at exactly max lines when under byte limit', async () => {
      // Use single-char lines so total bytes stay under TRUNCATION_MAX_BYTES
      // TRUNCATION_MAX_LINES lines of "x\n" = 2 bytes each = 4000 bytes ≤ 4096
      const lines = Array(TRUNCATION_MAX_LINES).fill('x');
      const output = lines.join('\n');
      // Sanity: must be under byte limit for this test to be meaningful
      expect(Buffer.byteLength(output, 'utf-8')).toBeLessThanOrEqual(TRUNCATION_MAX_BYTES);
      const result = await truncateToolOutput(output, 'bash', 'call_xyz', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
    });

    it('does not create spillover file when not truncated', async () => {
      const output = 'Small output';
      await truncateToolOutput(output, 'read', 'call_123', workspace);

      const spilloverDir = join(workspace, TRUNCATION_DIR);
      expect(existsSync(spilloverDir)).toBe(false);
    });
  });

  describe('fetch always saves (even small results)', () => {
    it('saves small fetch result to .motor-output/', async () => {
      const output = 'Small fetch result';
      const result = await truncateToolOutput(output, 'fetch', 'call_123', workspace);

      expect(result.truncated).toBe(true);
      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/fetch-call_123.txt`);
      expect(result.content).toContain('Output saved');
      expect(result.content).toContain('.motor-output/fetch-call_123.txt');
    });

    it('saves large fetch result to .motor-output/', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 1000);
      const result = await truncateToolOutput(output, 'fetch', 'call_abc', workspace);

      expect(result.truncated).toBe(true);
      expect(result.originalBytes).toBe(TRUNCATION_MAX_BYTES + 1000);
      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/fetch-call_abc.txt`);
    });

    it('returns fetch error inline when toolOk is false', async () => {
      const output = 'BLOCKED: Domain api.example.com is not in allowed list.';
      const result = await truncateToolOutput(output, 'fetch', 'call_123', workspace, {
        toolOk: false,
      });

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
    });

    it('preserves full content in saved file', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 500);
      const result = await truncateToolOutput(output, 'fetch', 'call_test', workspace);

      const savedPath = join(workspace, result.savedPath!);
      const savedContent = await readFile(savedPath, 'utf-8');
      expect(savedContent).toBe(output);
    });
  });

  describe('byte limit trigger (non-fetch tools)', () => {
    it('truncates when byte limit exceeded', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 1000);
      const result = await truncateToolOutput(output, 'bash', 'call_abc', workspace);

      expect(result.truncated).toBe(true);
      expect(result.originalBytes).toBe(TRUNCATION_MAX_BYTES + 1000);
      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/bash-call_abc.txt`);
    });

    it('returns pointer with no content preview', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 500);
      const result = await truncateToolOutput(output, 'bash', 'call_xyz', workspace);

      expect(result.content).toContain('Output saved');
      expect(result.content).toContain('.motor-output/bash-call_xyz.txt');
      expect(result.content).toContain('cp');
      expect(result.content).toContain('read');
    });

    it('saves full content to file', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 500);
      const result = await truncateToolOutput(output, 'bash', 'call_test', workspace);

      const savedPath = join(workspace, result.savedPath!);
      const savedContent = await readFile(savedPath, 'utf-8');
      expect(savedContent).toBe(output);
    });
  });

  describe('line limit trigger (non-fetch tools)', () => {
    it('truncates when line limit exceeded', async () => {
      const lines = Array(TRUNCATION_MAX_LINES + 100).fill('line');
      const output = lines.join('\n');
      const result = await truncateToolOutput(output, 'bash', 'call_def', workspace);

      expect(result.truncated).toBe(true);
      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/bash-call_def.txt`);
    });

    it('returns pointer with no content preview (no inline head lines)', async () => {
      const lines = Array(TRUNCATION_MAX_LINES + 100).fill('line');
      lines[0] = 'FIRST_LINE';
      lines[1] = 'SECOND_LINE';
      const output = lines.join('\n');

      const result = await truncateToolOutput(output, 'bash', 'call_xyz', workspace);

      // No preview — just pointer metadata
      expect(result.content).toContain('Output saved');
      expect(result.content).not.toContain('FIRST_LINE');
      expect(result.content).not.toContain('SECOND_LINE');
    });
  });

  describe('fetch error inline (toolOk: false)', () => {
    it('does not save BLOCKED: Domain messages', async () => {
      const output = 'BLOCKED: Domain api.example.com is not in allowed list.';
      const result = await truncateToolOutput(output, 'fetch', 'call_123', workspace, {
        toolOk: false,
      });

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
    });

    it('preserves domain error messages exactly', async () => {
      const output =
        'BLOCKED: Domain raw.githubusercontent.com is not in allowed list. Allowed domains: github.com.';
      const result = await truncateToolOutput(output, 'fetch', 'call_xyz', workspace, {
        toolOk: false,
      });

      expect(result.truncated).toBe(false);
      expect(result.content).toContain('BLOCKED: Domain');
      expect(result.content).toContain('raw.githubusercontent.com');
    });
  });

  describe('file naming', () => {
    it('uses tool name and last 8 chars of call ID in filename', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 100);
      const result = await truncateToolOutput(output, 'bash', 'call_abcdefgh12345678', workspace);

      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/bash-12345678.txt`);
    });

    it('handles short call IDs', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 100);
      const result = await truncateToolOutput(output, 'bash', 'abc', workspace);

      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/bash-abc.txt`);
    });
  });

  describe('edge cases', () => {
    it('handles empty string (non-fetch)', async () => {
      const result = await truncateToolOutput('', 'read', 'call_123', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe('');
    });

    it('handles single very long line', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 5000);
      const result = await truncateToolOutput(output, 'bash', 'call_123', workspace);

      expect(result.truncated).toBe(true);
    });

    it('handles unicode content correctly', async () => {
      // Unicode characters can be multi-byte — 4 bytes each
      const output = '🎉'.repeat(TRUNCATION_MAX_BYTES);
      const result = await truncateToolOutput(output, 'bash', 'call_123', workspace);

      expect(result.truncated).toBe(true);
      expect(result.originalBytes!).toBeGreaterThan(TRUNCATION_MAX_BYTES);
    });

    it('creates .motor-output directory if needed', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 100);
      await truncateToolOutput(output, 'bash', 'call_123', workspace);

      const spilloverDir = join(workspace, TRUNCATION_DIR);
      expect(existsSync(spilloverDir)).toBe(true);
    });
  });
});
