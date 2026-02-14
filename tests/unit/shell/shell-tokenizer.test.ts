/**
 * Unit tests for shell tokenizer.
 */

import { describe, it, expect } from 'vitest';
import { tokenize, hasDangerousMetachars } from '../../../src/runtime/shell/shell-tokenizer.js';

describe('tokenize', () => {
  it('splits simple command into tokens', () => {
    const result = tokenize('echo hello world');
    expect(result.segments).toEqual([['echo', 'hello', 'world']]);
    expect(result.hasPipe).toBe(false);
  });

  it('handles double-quoted strings as single tokens', () => {
    const result = tokenize('echo "hello world"');
    expect(result.segments).toEqual([['echo', 'hello world']]);
  });

  it('handles single-quoted strings as single tokens', () => {
    const result = tokenize("echo 'hello world'");
    expect(result.segments).toEqual([['echo', 'hello world']]);
  });

  it('preserves backslash before non-special chars in double quotes (POSIX)', () => {
    // \n should keep the backslash — only $, `, ", \ are special after \
    const result = tokenize('echo "hello\\nworld"');
    expect(result.segments).toEqual([['echo', 'hello\\nworld']]);
  });

  it('preserves backslash in Windows-style paths in double quotes', () => {
    const result = tokenize('echo "C:\\temp\\file.txt"');
    expect(result.segments).toEqual([['echo', 'C:\\temp\\file.txt']]);
  });

  it('strips backslash before special chars in double quotes', () => {
    // \" inside double quotes should yield a literal "
    const result = tokenize('echo "say \\"hi\\""');
    expect(result.segments).toEqual([['echo', 'say "hi"']]);
  });

  it('strips backslash before \\\\ in double quotes', () => {
    const result = tokenize('echo "back\\\\slash"');
    expect(result.segments).toEqual([['echo', 'back\\slash']]);
  });

  it('strips backslash before $ in double quotes', () => {
    const result = tokenize('echo "cost\\$5"');
    expect(result.segments).toEqual([['echo', 'cost$5']]);
  });

  it('handles empty double-quoted string as empty token', () => {
    const result = tokenize('cmd "" arg');
    expect(result.segments).toEqual([['cmd', '', 'arg']]);
  });

  it('handles empty single-quoted string as empty token', () => {
    const result = tokenize("cmd '' arg");
    expect(result.segments).toEqual([['cmd', '', 'arg']]);
  });

  it('splits pipeline by unquoted pipe', () => {
    const result = tokenize('cat file | grep pattern');
    expect(result.segments).toEqual([['cat', 'file'], ['grep', 'pattern']]);
    expect(result.hasPipe).toBe(true);
  });

  it('does not split by pipe inside double quotes', () => {
    const result = tokenize('echo "a|b"');
    expect(result.segments).toEqual([['echo', 'a|b']]);
    expect(result.hasPipe).toBe(false);
  });

  it('does not split by pipe inside single quotes', () => {
    const result = tokenize("echo 'a|b'");
    expect(result.segments).toEqual([['echo', 'a|b']]);
    expect(result.hasPipe).toBe(false);
  });

  it('returns empty segments for unterminated double quote', () => {
    const result = tokenize('echo "hello');
    expect(result.segments).toEqual([]);
  });

  it('returns empty segments for unterminated single quote', () => {
    const result = tokenize("echo 'hello");
    expect(result.segments).toEqual([]);
  });

  it('handles adjacent quoted and unquoted text', () => {
    const result = tokenize('echo pre"mid"post');
    expect(result.segments).toEqual([['echo', 'premidpost']]);
  });

  it('handles multi-segment pipeline', () => {
    const result = tokenize('cat f | sort | uniq -c');
    expect(result.segments).toEqual([['cat', 'f'], ['sort'], ['uniq', '-c']]);
    expect(result.hasPipe).toBe(true);
  });

  // Outside-quote backslash escaping
  it('backslash outside quotes escapes the next character', () => {
    // echo hello\ world → single token "hello world"
    const result = tokenize('echo hello\\ world');
    expect(result.segments).toEqual([['echo', 'hello world']]);
  });

  it('backslash outside quotes escapes pipe (not a pipeline)', () => {
    const result = tokenize('echo a\\|b');
    expect(result.segments).toEqual([['echo', 'a|b']]);
    expect(result.hasPipe).toBe(false);
  });

  it('backslash outside quotes escapes quotes', () => {
    const result = tokenize('echo \\"hello\\"');
    expect(result.segments).toEqual([['echo', '"hello"']]);
  });

  it('trailing backslash outside quotes is preserved', () => {
    const result = tokenize('echo test\\');
    expect(result.segments).toEqual([['echo', 'test\\']]);
  });
});

describe('hasDangerousMetachars', () => {
  it('returns false for simple commands', () => {
    expect(hasDangerousMetachars('echo hello')).toBe(false);
  });

  it('allows semicolons (safe in sandboxed container with command allowlist)', () => {
    expect(hasDangerousMetachars('echo ok; rm -rf /')).toBe(false);
  });

  it('allows for loops with semicolons', () => {
    expect(hasDangerousMetachars('for f in a b; do echo $f; done')).toBe(false);
  });

  it('allows while loops with semicolons', () => {
    expect(hasDangerousMetachars('while true; do echo hi; done')).toBe(false);
  });

  it('detects $() expansion', () => {
    expect(hasDangerousMetachars('echo $(id)')).toBe(true);
  });

  it('detects backticks', () => {
    expect(hasDangerousMetachars('echo `id`')).toBe(true);
  });

  it('allows & when unquoted (safe in sandboxed container)', () => {
    expect(hasDangerousMetachars('echo ok & bg')).toBe(false);
  });

  it('allows & inside double quotes', () => {
    expect(hasDangerousMetachars('curl "http://a.com?x=1&y=2" | cat')).toBe(false);
  });

  it('allows & inside single quotes', () => {
    expect(hasDangerousMetachars("curl 'http://a.com?x=1&y=2' | cat")).toBe(false);
  });

  it('allows $ variable reference inside double quotes (only $( is dangerous)', () => {
    expect(hasDangerousMetachars('echo "$HOME"')).toBe(false);
  });

  it('allows $ inside single quotes', () => {
    expect(hasDangerousMetachars("echo '$HOME'")).toBe(false);
  });

  it('allows backslash outside quotes (safe in sandboxed container)', () => {
    expect(hasDangerousMetachars('echo \\n')).toBe(false);
  });

  it('rejects backtick inside double quotes', () => {
    expect(hasDangerousMetachars('echo "`id`"')).toBe(true);
  });

  it('returns false for pipes (not in dangerous set)', () => {
    expect(hasDangerousMetachars('cat file | grep pattern')).toBe(false);
  });

  it('allows backslash inside double quotes (safe in sh -c)', () => {
    expect(hasDangerousMetachars('echo "C:\\temp" | cat')).toBe(false);
  });

  it('allows backslash-backslash inside double quotes', () => {
    expect(hasDangerousMetachars('echo "a\\\\b" | cat')).toBe(false);
  });
});
