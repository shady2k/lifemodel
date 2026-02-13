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

  describe('under-limit passthrough', () => {
    it('returns original content when under both limits', async () => {
      const output = 'Hello, world!';
      const result = await truncateToolOutput(output, 'read', 'call_123', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
      expect(result.originalBytes).toBeUndefined();
      expect(result.savedPath).toBeUndefined();
    });

    it('returns original content at exactly max bytes', async () => {
      // Create output exactly at byte limit
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES);
      const result = await truncateToolOutput(output, 'fetch', 'call_abc', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
    });

    it('returns original content at exactly max lines', async () => {
      // Create output with exactly max lines
      const lines = Array(TRUNCATION_MAX_LINES).fill('line');
      const output = lines.join('\n');
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

  describe('byte limit trigger', () => {
    it('truncates when byte limit exceeded', async () => {
      // Create output that exceeds byte limit but not line limit
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 1000);
      const result = await truncateToolOutput(output, 'fetch', 'call_abc', workspace);

      expect(result.truncated).toBe(true);
      expect(result.originalBytes).toBe(TRUNCATION_MAX_BYTES + 1000);
      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/fetch-call_abc.txt`);
    });

    it('includes hint message with file path', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 500);
      const result = await truncateToolOutput(output, 'fetch', 'call_xyz', workspace);

      expect(result.content).toContain('Output truncated');
      expect(result.content).toContain('.motor-output/fetch-call_xyz.txt');
      expect(result.content).toContain('use read with offset/limit or grep');
    });

    it('reports bytes truncated when byte limit hit', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 500);
      const result = await truncateToolOutput(output, 'fetch', 'call_123', workspace);

      expect(result.content).toContain('bytes truncated');
      expect(result.content).not.toContain('lines truncated');
    });

    it('saves full content to file', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 500);
      const result = await truncateToolOutput(output, 'fetch', 'call_test', workspace);

      // Read the saved file
      const savedPath = join(workspace, result.savedPath!);
      const savedContent = await readFile(savedPath, 'utf-8');
      expect(savedContent).toBe(output);
    });
  });

  describe('line limit trigger', () => {
    it('truncates when line limit exceeded', async () => {
      // Create output that exceeds line limit but not byte limit (short lines)
      const lines = Array(TRUNCATION_MAX_LINES + 100).fill('line');
      const output = lines.join('\n');
      const result = await truncateToolOutput(output, 'bash', 'call_def', workspace);

      expect(result.truncated).toBe(true);
      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/bash-call_def.txt`);
    });

    it('reports lines truncated when line limit hit', async () => {
      const lines = Array(TRUNCATION_MAX_LINES + 100).fill('line');
      const output = lines.join('\n');
      const result = await truncateToolOutput(output, 'bash', 'call_123', workspace);

      expect(result.content).toContain('lines truncated');
      expect(result.content).not.toContain('bytes truncated');
    });

    it('preserves preview lines from head', async () => {
      const lines = Array(TRUNCATION_MAX_LINES + 50).fill('line');
      // Make first few lines unique to verify they're preserved
      lines[0] = 'FIRST_LINE';
      lines[1] = 'SECOND_LINE';
      const output = lines.join('\n');

      const result = await truncateToolOutput(output, 'bash', 'call_xyz', workspace);

      expect(result.content).toContain('FIRST_LINE');
      expect(result.content).toContain('SECOND_LINE');
    });
  });

  describe('file naming', () => {
    it('uses tool name and last 8 chars of call ID in filename', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 100);
      const result = await truncateToolOutput(output, 'fetch', 'call_abcdefgh12345678', workspace);

      // 'call_abcdefgh12345678' (21 chars).slice(-8) = '12345678'
      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/fetch-12345678.txt`);
    });

    it('handles short call IDs', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 100);
      const result = await truncateToolOutput(output, 'bash', 'abc', workspace);

      expect(result.savedPath).toBe(`${TRUNCATION_DIR}/bash-abc.txt`);
    });
  });

  describe('domain block messages (short, never truncated)', () => {
    it('does not truncate BLOCKED: Domain messages', async () => {
      const output = 'BLOCKED: Domain api.example.com is not in allowed list.';
      const result = await truncateToolOutput(output, 'fetch', 'call_123', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe(output);
    });

    it('preserves domain error messages exactly', async () => {
      const output =
        'BLOCKED: Domain raw.githubusercontent.com is not in allowed list. Allowed domains: github.com.';
      const result = await truncateToolOutput(output, 'fetch', 'call_xyz', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toContain('BLOCKED: Domain');
      expect(result.content).toContain('raw.githubusercontent.com');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', async () => {
      const result = await truncateToolOutput('', 'read', 'call_123', workspace);

      expect(result.truncated).toBe(false);
      expect(result.content).toBe('');
    });

    it('handles single very long line', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 5000);
      const result = await truncateToolOutput(output, 'fetch', 'call_123', workspace);

      expect(result.truncated).toBe(true);
      // Single line, so preview should be empty (no newline to break on)
      // The algorithm stops when adding the next line would exceed bytes
    });

    it('handles unicode content correctly', async () => {
      // Unicode characters can be multi-byte
      const output = '🎉'.repeat(TRUNCATION_MAX_BYTES); // Each emoji is 4 bytes
      const result = await truncateToolOutput(output, 'fetch', 'call_123', workspace);

      expect(result.truncated).toBe(true);
      expect(result.originalBytes!).toBeGreaterThan(TRUNCATION_MAX_BYTES);
    });

    it('creates .motor-output directory if needed', async () => {
      const output = 'x'.repeat(TRUNCATION_MAX_BYTES + 100);
      await truncateToolOutput(output, 'fetch', 'call_123', workspace);

      const spilloverDir = join(workspace, TRUNCATION_DIR);
      expect(existsSync(spilloverDir)).toBe(true);
    });
  });
});
