/**
 * Unit tests for Motor Cortex Phase 2 tools: shell, grep, patch, and expanded filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { executeTool, resolveSafePath, type ToolContext } from '../../../src/runtime/motor-cortex/motor-tools.js';

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
    ctx = { workspace, allowedRoots: [workspace] };

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
    ctx = { workspace, allowedRoots: [workspace] };
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
    ctx = { workspace, allowedRoots: [workspace] };
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

describe('filesystem tool with multiple roots', () => {
  let workspace: string;
  let skillsDir: string;
  let ctx: ToolContext;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'motor-test-'));
    skillsDir = await mkdtemp(join(tmpdir(), 'motor-skills-'));
    ctx = { workspace, allowedRoots: [workspace, skillsDir] };
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
    await rm(skillsDir, { recursive: true, force: true });
  });

  it('writes to skills directory', async () => {
    // Use a relative path — it will be resolved against each allowed root
    await mkdir(join(skillsDir, 'test-skill'), { recursive: true });
    const result = await executeTool(
      'filesystem',
      {
        action: 'write',
        path: 'test-skill/SKILL.md',
        content: '---\nname: test\n---\nBody',
      },
      // Create context with skills dir as workspace (relative paths resolve against it)
      { workspace: skillsDir, allowedRoots: [workspace, skillsDir] }
    );
    expect(result.ok).toBe(true);
  });

  it('creates parent directories on write', async () => {
    const result = await executeTool(
      'filesystem',
      {
        action: 'write',
        path: 'subdir/deep/file.txt',
        content: 'hello',
      },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(result.output).toContain('Wrote');
  });
});
