/**
 * Unit tests for Motor Cortex Phase 2 tools: shell, grep, patch, and expanded filesystem.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFile, mkdir, rm, symlink, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import {
  executeTool,
  resolveSafePath,
  type ToolContext,
  type MotorFetchFn,
  type MotorSearchFn,
} from '../../../src/runtime/motor-cortex/motor-tools.js';

describe('resolveSafePath', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('resolves paths within allowed root', async () => {
    const result = await resolveSafePath([workspace], 'file.txt');
    expect(result).toBe(join(workspace, 'file.txt'));
  });

  it('rejects paths that escape root', async () => {
    const result = await resolveSafePath([workspace], '../../../etc/passwd');
    expect(result).toBeNull();
  });

  it('allows paths in any of multiple allowed roots', async () => {
    const root2 = await mkdtemp(join(tmpdir(), 'motor-test-root2-'));
    try {
      await writeFile(join(root2, 'test.txt'), 'hello');
      const result = await resolveSafePath([workspace, root2], 'test.txt');
      expect(result).not.toBeNull();
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  it('rejects symlinks that escape roots', async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), 'motor-test-outside-'));
    await writeFile(join(outsideDir, 'secret.txt'), 'secret');

    try {
      await symlink(outsideDir, join(workspace, 'escape'));
      const result = await resolveSafePath([workspace], 'escape/secret.txt');
      // Should be null because the symlink resolves outside workspace
      expect(result).toBeNull();
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('grep tool', () => {
  let workspace: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    ctx = { workspace, allowedRoots: [workspace], writeRoots: [workspace] };

    // Create test files
    await writeFile(join(workspace, 'hello.ts'), 'const foo = "hello";\nconst bar = "world";\n');
    await writeFile(join(workspace, 'bye.ts'), 'const baz = "goodbye";\n');
    await mkdir(join(workspace, 'sub'));
    await writeFile(join(workspace, 'sub', 'nested.ts'), 'const nested = "hello";\n');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('finds matches across files', async () => {
    const result = await executeTool('grep', { pattern: 'hello' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello.ts:1:');
    expect(result.output).toContain('sub/nested.ts:1:');
  });

  it('filters by glob pattern', async () => {
    const result = await executeTool('grep', { pattern: 'hello', glob: '*.ts' }, ctx);
    expect(result.ok).toBe(true);
    // Should find hello.ts but also nested.ts since glob checks filename
    expect(result.output).toContain('hello.ts:1:');
  });

  it('returns no matches message when nothing found', async () => {
    const result = await executeTool('grep', { pattern: 'zzz_nonexistent' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('No matches found');
  });

  it('rejects missing pattern', async () => {
    const result = await executeTool('grep', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_args');
  });
});

describe('patch tool', () => {
  let workspace: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    ctx = { workspace, allowedRoots: [workspace], writeRoots: [workspace] };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('replaces unique text occurrence', async () => {
    await writeFile(join(workspace, 'file.txt'), 'line1\nline2\nline3\n');
    const result = await executeTool(
      'patch',
      { path: 'file.txt', old_text: 'line2', new_text: 'REPLACED' },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Patched file.txt');
  });

  it('errors on zero matches', async () => {
    await writeFile(join(workspace, 'file.txt'), 'content');
    const result = await executeTool(
      'patch',
      { path: 'file.txt', old_text: 'nonexistent', new_text: 'new' },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('not_found');
  });

  it('errors on multiple matches', async () => {
    await writeFile(join(workspace, 'file.txt'), 'aaa\naaa\n');
    const result = await executeTool(
      'patch',
      { path: 'file.txt', old_text: 'aaa', new_text: 'bbb' },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('found 2+ times');
    expect(result.retryable).toBe(true);
  });

  it('rejects path traversal', async () => {
    const result = await executeTool(
      'patch',
      { path: '../../etc/passwd', old_text: 'root', new_text: 'hacked' },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('permission_denied');
  });
});

describe('shell tool', () => {
  let ctx: ToolContext;
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    ctx = { workspace, allowedRoots: [workspace], writeRoots: [workspace] };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('runs allowlisted commands', async () => {
    const result = await executeTool('shell', { command: 'echo hello' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('rejects non-allowlisted commands', async () => {
    const result = await executeTool('shell', { command: 'node -e "process.exit(1)"' }, ctx);
    expect(result.ok).toBe(false);
  });

  it('rejects missing command', async () => {
    const result = await executeTool('shell', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_args');
  });

  it('handles double-quoted arguments', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo "hello world"' },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('handles single-quoted arguments', async () => {
    const result = await executeTool(
      'shell',
      { command: "echo 'hello world'" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello world');
  });

  it('does not treat pipe inside quotes as pipeline', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo "a|b"' },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a|b');
  });

  it('rejects unterminated quotes', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo "hello' },
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('rejects shell injection in pipelines', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo ok; rm -rf / | cat' },
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('rejects $() expansion in pipelines', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo "$(id)" | cat' },
      ctx
    );
    expect(result.ok).toBe(false);
  });

  it('preserves backslash in double-quoted non-special chars', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo "hello\\nworld"' },
      ctx
    );
    expect(result.ok).toBe(true);
    // execFile passes args directly — backslash should be preserved
    expect(result.output).toContain('hello\\nworld');
  });

  it('preserves empty quoted arguments', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo "" "hello"' },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('hello');
  });

  it('allows & inside double quotes in pipelines', async () => {
    const result = await executeTool(
      'shell',
      { command: 'echo "a&b" | cat' },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('a&b');
  });
});

describe('read/write/list tools with multiple roots', () => {
  let workspace: string;
  let skillsDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    skillsDir = await mkdtemp(join(tmpdir(), 'motor-skills-'));
    ctx = { workspace, allowedRoots: [workspace, skillsDir], writeRoots: [workspace] };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('read tool reads from workspace (allowedRoots)', async () => {
    await mkdir(join(workspace, 'read-test'), { recursive: true });
    await writeFile(join(workspace, 'read-test', 'file.txt'), 'content from workspace', 'utf-8');

    const result = await executeTool('read', { path: 'read-test/file.txt' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('content from workspace');
  });

  it('read tool returns line numbers', async () => {
    await writeFile(join(workspace, 'lines.txt'), 'line1\nline2\nline3\n', 'utf-8');
    const result = await executeTool('read', { path: 'lines.txt' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('1| line1');
    expect(result.output).toContain('2| line2');
  });

  it('read tool supports offset/limit', async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    await writeFile(join(workspace, 'big.txt'), lines, 'utf-8');
    const result = await executeTool('read', { path: 'big.txt', offset: 3, limit: 2 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('line3');
    expect(result.output).toContain('line4');
    expect(result.output).not.toContain('line5');
  });

  it('read tool returns not_found for missing file', async () => {
    const result = await executeTool('read', { path: 'nonexistent.txt' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('not_found');
  });

  it('write tool constrains to writeRoots', async () => {
    await mkdir(join(skillsDir, 'write-test'), { recursive: true });

    const result = await executeTool(
      'write',
      { path: 'write-test/file.txt', content: 'content in workspace' },
      ctx
    );
    expect(result.ok).toBe(true);

    const workspaceFile = await readFile(join(workspace, 'write-test', 'file.txt'), 'utf-8').catch(() => null);
    const skillsFile = await readFile(join(skillsDir, 'write-test', 'file.txt'), 'utf-8').catch(() => null);
    expect(workspaceFile).toBe('content in workspace');
    expect(skillsFile).toBeNull();
  });

  it('write tool creates parent directories', async () => {
    const result = await executeTool(
      'write',
      { path: 'subdir/deep/file.txt', content: 'hello' },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Wrote');
  });

  it('list tool returns sorted entries with DIR/FILE markers', async () => {
    await mkdir(join(workspace, 'adir'));
    await writeFile(join(workspace, 'bfile.txt'), 'content');
    const result = await executeTool('list', { path: '.' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('[DIR]  adir');
    expect(result.output).toContain('[FILE] bfile.txt');
  });

  it('list tool returns graceful message for missing dir', async () => {
    const result = await executeTool('list', { path: 'nonexistent' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('does not exist');
  });

  it('filesystem compat shim routes to read/write/list', async () => {
    await writeFile(join(workspace, 'compat.txt'), 'compat content', 'utf-8');
    const result = await executeTool('filesystem', { action: 'read', path: 'compat.txt' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('compat content');
  });
});

describe('write tool writeRoots security', () => {
  let workspace: string;
  let skillsDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    skillsDir = await mkdtemp(join(tmpdir(), 'motor-skills-'));
    ctx = { workspace, allowedRoots: [workspace, skillsDir], writeRoots: [workspace] };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('rejects writes via symlink pointing outside writeRoots', async () => {
    await writeFile(join(skillsDir, 'target.txt'), 'secret', 'utf-8');

    try {
      await symlink(join(skillsDir, 'target.txt'), join(workspace, 'link.txt'));
    } catch {
      return;
    }

    const result = await executeTool(
      'write',
      { path: 'link.txt', content: 'modified' },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('permission_denied');
  });

  it('rejects write to existing symlink in workspace', async () => {
    await writeFile(join(workspace, 'original.txt'), 'original', 'utf-8');

    try {
      await symlink(join(skillsDir, 'outside.txt'), join(workspace, 'symlink.txt'));
    } catch {
      return;
    }

    const result = await executeTool(
      'write',
      { path: 'symlink.txt', content: 'should not write' },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('permission_denied');
  });
});

describe('glob tool', () => {
  let workspace: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    ctx = { workspace, allowedRoots: [workspace], writeRoots: [workspace] };

    await writeFile(join(workspace, 'index.ts'), 'export {};');
    await writeFile(join(workspace, 'readme.md'), '# Hello');
    await mkdir(join(workspace, 'src'));
    await writeFile(join(workspace, 'src', 'main.ts'), 'console.log("hi")');
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('finds files matching glob pattern', async () => {
    const result = await executeTool('glob', { pattern: '**/*.ts' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('index.ts');
    expect(result.output).toContain('src/main.ts');
    expect(result.output).not.toContain('readme.md');
  });

  it('rejects missing pattern', async () => {
    const result = await executeTool('glob', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_args');
  });

  it('rejects path escape in pattern', async () => {
    const result = await executeTool('glob', { pattern: '../**/*.ts' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('permission_denied');
  });

  it('returns no-match message for no results', async () => {
    const result = await executeTool('glob', { pattern: '**/*.xyz' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('No files matched');
  });
});

describe('fetch tool', () => {
  let workspace: string;
  let ctx: ToolContext;
  let mockFetchFn: MotorFetchFn;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    ctx = { workspace, allowedRoots: [workspace], writeRoots: [workspace] };
    mockFetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      content: '<html>response content</html>',
      contentType: 'text/html',
    });
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('rejects missing url', async () => {
    const result = await executeTool('fetch', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_args');
  });

  it('checks domain against allowedDomains - allows exact match', async () => {
    ctx.allowedDomains = ['api.example.com'];
    ctx.fetchFn = mockFetchFn;

    const result = await executeTool('fetch', { url: 'https://api.example.com/data' }, ctx);
    expect(result.ok).toBe(true);
    expect(mockFetchFn).toHaveBeenCalledWith('https://api.example.com/data', expect.anything());
  });

  it('checks domain against allowedDomains - allows subdomain match', async () => {
    ctx.allowedDomains = ['example.com'];
    ctx.fetchFn = mockFetchFn;

    const result = await executeTool('fetch', { url: 'https://api.example.com/data' }, ctx);
    expect(result.ok).toBe(true);
  });

  it('blocks domain not in allowedDomains list', async () => {
    ctx.allowedDomains = ['api.example.com'];
    ctx.fetchFn = mockFetchFn;

    const result = await executeTool('fetch', { url: 'https://other.com/data' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('permission_denied');
    expect(result.output).toContain('Domain other.com not allowed');
    expect(result.output).toContain('Allowed domains: api.example.com');
  });

  it('rejects invalid URL format', async () => {
    ctx.allowedDomains = ['example.com'];
    ctx.fetchFn = mockFetchFn;

    const result = await executeTool('fetch', { url: 'not-a-url' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_args');
  });

  it('returns tool_not_available when fetchFn is undefined', async () => {
    ctx.allowedDomains = ['example.com'];
    // @ts-expect-error - intentionally not providing fetchFn
    delete (ctx as Partial<ToolContext>).fetchFn;

    const result = await executeTool('fetch', { url: 'https://example.com' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('tool_not_available');
    expect(result.output).toContain('Fetch not configured');
  });

  it('truncates response to 10KB', async () => {
    ctx.allowedDomains = ['example.com'];
    const longContent = 'x'.repeat(15 * 1024); // 15KB
    ctx.fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      content: longContent,
      contentType: 'text/plain',
    });

    const result = await executeTool('fetch', { url: 'https://example.com/data' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(10 * 1024 + 100); // +100 for truncation message
    expect(result.output).toContain('response truncated');
  });

  it('handles fetch errors', async () => {
    ctx.allowedDomains = ['example.com'];
    ctx.fetchFn = vi.fn().mockRejectedValue(new Error('Network timeout'));

    const result = await executeTool('fetch', { url: 'https://example.com/data' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('execution_error');
    expect(result.output).toContain('Network timeout');
  });
});

describe('search tool', () => {
  let workspace: string;
  let ctx: ToolContext;
  let mockSearchFn: MotorSearchFn;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    ctx = { workspace, allowedRoots: [workspace], writeRoots: [workspace] };
    mockSearchFn = vi.fn().mockResolvedValue([
      { title: 'Test Result', url: 'https://example.com/test', snippet: 'Test snippet' },
    ]);
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  it('rejects missing query', async () => {
    const result = await executeTool('search', {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('invalid_args');
  });

  it('returns tool_not_available when searchFn is undefined', async () => {
    // @ts-expect-error - intentionally not providing searchFn
    delete (ctx as Partial<ToolContext>).searchFn;

    const result = await executeTool('search', { query: 'test query' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('tool_not_available');
    expect(result.output).toContain('Search not configured');
  });

  it('calls searchFn with query and default limit', async () => {
    ctx.searchFn = mockSearchFn;

    const result = await executeTool('search', { query: 'test query' }, ctx);
    expect(result.ok).toBe(true);
    expect(mockSearchFn).toHaveBeenCalledWith('test query', 5);
  });

  it('respects custom limit up to 10', async () => {
    ctx.searchFn = mockSearchFn;

    const result = await executeTool('search', { query: 'test', limit: 8 }, ctx);
    expect(result.ok).toBe(true);
    expect(mockSearchFn).toHaveBeenCalledWith('test', 8);
  });

  it('caps limit at 10', async () => {
    ctx.searchFn = mockSearchFn;

    const result = await executeTool('search', { query: 'test', limit: 15 }, ctx);
    expect(result.ok).toBe(true);
    expect(mockSearchFn).toHaveBeenCalledWith('test', 10);
  });

  it('formats results as numbered list', async () => {
    ctx.searchFn = mockSearchFn;

    const result = await executeTool('search', { query: 'test' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toContain('1. Test Result');
    expect(result.output).toContain('URL: https://example.com/test');
    expect(result.output).toContain('Test snippet');
  });

  it('handles empty results', async () => {
    const emptyMock: MotorSearchFn = vi.fn().mockResolvedValue([]);
    ctx.searchFn = emptyMock;

    const result = await executeTool('search', { query: 'nothing' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.output).toBe('No results found');
  });

  it('handles search errors', async () => {
    ctx.searchFn = vi.fn().mockRejectedValue(new Error('Search API error'));

    const result = await executeTool('search', { query: 'test' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('execution_error');
    expect(result.output).toContain('Search API error');
  });
});
