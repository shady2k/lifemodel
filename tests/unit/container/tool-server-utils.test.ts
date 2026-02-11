/**
 * Unit tests for tool-server utility functions.
 *
 * These tests cover security-critical paths that were previously untested:
 * - Shell validation (pipeline validation, allowlist, metacharacter rejection)
 * - Glob matching for file filtering
 * - Credential placeholder resolution
 * - Patch find-unique-substring logic
 */

import { describe, it, expect } from 'vitest';
import {
  validatePipeline,
  matchesGlob,
  matchesGlobPattern,
  resolveCredentialPlaceholders,
  findUniqueSubstring,
  fuzzyFindUnique,
  splitOnUnquotedPipe,
  SHELL_ALLOWLIST,
  NETWORK_COMMANDS,
  CONTROL_OPERATORS_RE,
  DANGEROUS_METACHAR_RE,
  CREDENTIAL_PLACEHOLDER,
  type FindUniqueSubstringResult,
} from '../../../src/runtime/container/tool-server-utils.js';

describe('validatePipeline', () => {
  describe('allowed commands', () => {
    it('allows simple echo with no network', () => {
      const result = validatePipeline('echo hello');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });

    it('allows cat command', () => {
      const result = validatePipeline('cat file.txt');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });

    it('allows pipeline with safe commands', () => {
      const result = validatePipeline('cat file.txt | grep pattern');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });

    it('allows curl when hasNetwork=true', () => {
      const result = validatePipeline('curl https://example.com');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(true);
    });

    it('allows pipeline with curl and jq', () => {
      const result = validatePipeline('curl https://api.example.com | jq .data');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(true);
    });

    it('allows wget (network command)', () => {
      const result = validatePipeline('wget https://example.com/file.txt -O -');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(true);
    });

    it('allows complex pipeline with multiple safe commands', () => {
      const result = validatePipeline('cat data.json | jq .users[] | grep admin | wc -l');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });
  });

  describe('allowed: control operators (&&, ||)', () => {
    it('allows || operator with valid commands', () => {
      const result = validatePipeline('echo hello || echo fallback');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });

    it('allows && operator with valid commands', () => {
      const result = validatePipeline('mkdir dir && ls dir');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });

    it('validates allowlist in && and || chains', () => {
      const result = validatePipeline('echo test || bash bad.sh && echo done');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Command not allowed');
      expect(result.error).toContain('bash');
    });
  });

  describe('rejected: dangerous metacharacters', () => {
    it('rejects command substitution $()', () => {
      const result = validatePipeline('echo $(whoami)');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('metacharacters');
    });

    it('rejects backtick command substitution', () => {
      const result = validatePipeline('echo `id`');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('metacharacters');
    });

    it('rejects semicolon command chaining', () => {
      const result = validatePipeline('echo test; cat /etc/passwd');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('metacharacters');
    });

    it('allows output redirection (safe in sandboxed container)', () => {
      const result = validatePipeline('echo test > /etc/passwd');
      expect(result.ok).toBe(true);
    });

    it('allows standalone newline (safe in sandboxed container)', () => {
      const result = validatePipeline('echo test\nrm -rf /');
      expect(result.ok).toBe(true);
    });

    it('still rejects semicolon with newline', () => {
      const result = validatePipeline('echo test;\nrm -rf /');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('metacharacters');
    });

    it('allows input redirection < (safe in sandboxed container)', () => {
      const result = validatePipeline('grep pattern < /etc/passwd');
      expect(result.ok).toBe(true);
    });

    it('allows ampersand backgrounding (safe in sandboxed container)', () => {
      const result = validatePipeline('echo test &');
      expect(result.ok).toBe(true);
    });

    it('allows single pipe while blocking other metachars', () => {
      const result = validatePipeline('cat file | grep test; rm -rf /');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('metacharacters');
    });
  });

  describe('allowed: container-isolated runtimes', () => {
    it('allows python3 command', () => {
      const result = validatePipeline('python3 script.py');
      expect(result.ok).toBe(true);
    });

    it('allows node command', () => {
      const result = validatePipeline('node script.js');
      expect(result.ok).toBe(true);
    });

    it('allows npm command', () => {
      const result = validatePipeline('npm install express');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(true);
    });
  });

  describe('rejected: not in allowlist', () => {
    it('rejects bash command', () => {
      const result = validatePipeline('bash -c "echo test"');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Command not allowed');
      expect(result.error).toContain('bash');
    });

    it('rejects sh command', () => {
      const result = validatePipeline('sh -c "echo test"');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Command not allowed');
      expect(result.error).toContain('sh');
    });

    it('rejects arbitrary binary', () => {
      const result = validatePipeline('malware');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Command not allowed');
    });
  });

  describe('rejected: empty pipeline segments', () => {
    it('rejects double pipes with empty segment', () => {
      const result = validatePipeline('echo | | grep');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Empty pipeline segment');
    });

    it('rejects leading pipe', () => {
      const result = validatePipeline('| grep test');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Empty pipeline segment');
    });

    it('rejects trailing pipe', () => {
      const result = validatePipeline('echo test |');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Empty pipeline segment');
    });
  });

  describe('edge cases', () => {
    it('handles command with path correctly', () => {
      const result = validatePipeline('/usr/bin/cat file.txt');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });

    it('handles command with multiple spaces', () => {
      const result = validatePipeline('echo    hello    world');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });

    it('handles complex grep with flags', () => {
      const result = validatePipeline('grep -i -n "pattern" file.txt');
      expect(result.ok).toBe(true);
      expect(result.hasNetwork).toBe(false);
    });
  });
});

describe('matchesGlob', () => {
  it('matches extension pattern *.ts', () => {
    expect(matchesGlob('file.ts', '*.ts')).toBe(true);
    expect(matchesGlob('component.tsx', '*.ts')).toBe(false);
    expect(matchesGlob('file.txt', '*.ts')).toBe(false);
  });

  it('matches extension pattern *.json', () => {
    expect(matchesGlob('data.json', '*.json')).toBe(true);
    expect(matchesGlob('config.json', '*.json')).toBe(true);
    expect(matchesGlob('data.yaml', '*.json')).toBe(false);
  });

  it('matches exact filename', () => {
    expect(matchesGlob('data.json', 'data.json')).toBe(true);
    expect(matchesGlob('data.json', 'other.json')).toBe(false);
  });

  it('matches extension pattern with path separator', () => {
    expect(matchesGlob('dir/file.ts', '*.ts')).toBe(true);
    expect(matchesGlob('src/utils/helper.ts', '*.ts')).toBe(true);
    expect(matchesGlob('dir/file.txt', '*.ts')).toBe(false);
  });

  it('handles empty pattern', () => {
    // Edge case: empty pattern - should only match empty string via exact match
    expect(matchesGlob('', '')).toBe(true);
    expect(matchesGlob('file.ts', '')).toBe(false);
  });
});

describe('resolveCredentialPlaceholders', () => {
  const createCredentialMap = (entries: [string, string][]): Map<string, string> => {
    return new Map(entries);
  };

  it('replaces single placeholder when found', () => {
    const credentials = createCredentialMap([['api_key', 'secret123']]);
    const result = resolveCredentialPlaceholders('key=<credential:api_key>', credentials);
    expect(result).toBe('key=secret123');
  });

  it('leaves placeholder as-is when not found', () => {
    const credentials = createCredentialMap([['api_key', 'secret123']]);
    const result = resolveCredentialPlaceholders('key=<credential:missing>', credentials);
    expect(result).toBe('key=<credential:missing>');
  });

  it('replaces multiple placeholders with all found', () => {
    const credentials = createCredentialMap([
      ['api_key', 'key123'],
      ['api_secret', 'secret456'],
    ]);
    const result = resolveCredentialPlaceholders(
      'key=<credential:api_key>&secret=<credential:api_secret>',
      credentials
    );
    expect(result).toBe('key=key123&secret=secret456');
  });

  it('leaves text unchanged when no placeholders', () => {
    const credentials = createCredentialMap([['api_key', 'secret123']]);
    const result = resolveCredentialPlaceholders('plain text with no placeholders', credentials);
    expect(result).toBe('plain text with no placeholders');
  });

  it('handles mixed found and missing placeholders', () => {
    const credentials = createCredentialMap([['api_key', 'secret123']]);
    const result = resolveCredentialPlaceholders(
      'key=<credential:api_key>&token=<credential:missing_token>',
      credentials
    );
    expect(result).toBe('key=secret123&token=<credential:missing_token>');
  });

  it('replaces same placeholder multiple times', () => {
    const credentials = createCredentialMap([['name', 'Alice']]);
    const result = resolveCredentialPlaceholders(
      'Hello <credential:name>, your name is <credential:name>',
      credentials
    );
    expect(result).toBe('Hello Alice, your name is Alice');
  });

  it('handles empty credential map', () => {
    const credentials = createCredentialMap([]);
    const result = resolveCredentialPlaceholders('key=<credential:api_key>', credentials);
    expect(result).toBe('key=<credential:api_key>');
  });
});

describe('findUniqueSubstring', () => {
  it('finds text that appears exactly once', () => {
    const result = findUniqueSubstring('hello world', 'world');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index).toBe(6);
      expect(result.count).toBe(1);
    }
  });

  it('returns not_found when text does not exist', () => {
    const result = findUniqueSubstring('hello world', 'goodbye');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  it('returns ambiguous when text appears multiple times', () => {
    const result = findUniqueSubstring('hello world hello', 'hello');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ambiguous');
    }
  });

  it('returns invalid_args for empty oldText', () => {
    const result = findUniqueSubstring('hello world', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_args');
    }
  });

  it('handles finding text at the beginning', () => {
    const result = findUniqueSubstring('hello world', 'hello');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index).toBe(0);
      expect(result.count).toBe(1);
    }
  });

  it('handles finding text at the end', () => {
    const result = findUniqueSubstring('hello world', 'world');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index).toBe(6);
    }
  });

  it('handles finding multi-line text', () => {
    const content = 'line1\nline2\nline3';
    const result = findUniqueSubstring(content, 'line2');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index).toBe(6); // After "line1\n"
      expect(result.count).toBe(1);
    }
  });

  it('returns ambiguous when text appears more than twice', () => {
    const result = findUniqueSubstring('a b a b a', 'a');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('ambiguous');
    }
  });

  it('handles exact match (entire content)', () => {
    const result = findUniqueSubstring('hello world', 'hello world');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index).toBe(0);
      expect(result.count).toBe(1);
    }
  });
});

describe('exported constants', () => {
  it('exports SHELL_ALLOWLIST as a Set', () => {
    expect(SHELL_ALLOWLIST).toBeInstanceOf(Set);
    expect(SHELL_ALLOWLIST.has('echo')).toBe(true);
    expect(SHELL_ALLOWLIST.has('git')).toBe(true);
    expect(SHELL_ALLOWLIST.has('python3')).toBe(true);
    expect(SHELL_ALLOWLIST.has('bash')).toBe(false);
  });

  it('exports NETWORK_COMMANDS as a Set', () => {
    expect(NETWORK_COMMANDS).toBeInstanceOf(Set);
    expect(NETWORK_COMMANDS.has('curl')).toBe(true);
    expect(NETWORK_COMMANDS.has('wget')).toBe(true);
    expect(NETWORK_COMMANDS.has('echo')).toBe(false);
  });

  it('exports CONTROL_OPERATORS_RE as RegExp', () => {
    expect(CONTROL_OPERATORS_RE).toBeInstanceOf(RegExp);
    expect(CONTROL_OPERATORS_RE.test('||')).toBe(true);
    expect(CONTROL_OPERATORS_RE.test('&&')).toBe(true);
    expect(CONTROL_OPERATORS_RE.test('|')).toBe(false);
  });

  it('exports DANGEROUS_METACHAR_RE as RegExp', () => {
    expect(DANGEROUS_METACHAR_RE).toBeInstanceOf(RegExp);
    expect(DANGEROUS_METACHAR_RE.test(';')).toBe(true);
    expect(DANGEROUS_METACHAR_RE.test('`')).toBe(true);
    expect(DANGEROUS_METACHAR_RE.test('$(')).toBe(true);
    // $ alone is NOT dangerous (only $( is)
    expect(DANGEROUS_METACHAR_RE.test('$')).toBe(false);
    // Single pipe is NOT in this regex (allowed)
    expect(DANGEROUS_METACHAR_RE.test('|')).toBe(false);
  });

  it('exports CREDENTIAL_PLACEHOLDER as RegExp', () => {
    expect(CREDENTIAL_PLACEHOLDER).toBeInstanceOf(RegExp);
    // Use exec() with global regex to get capture groups
    const nonGlobalRegex = new RegExp(CREDENTIAL_PLACEHOLDER.source, CREDENTIAL_PLACEHOLDER.flags.replace('g', ''));
    const match = '<credential:api_key>'.match(nonGlobalRegex);
    expect(match).toBeTruthy();
    expect(match?.[1]).toBe('api_key');
  });
});

describe('splitOnUnquotedPipe', () => {
  it('handles command without pipes', () => {
    const result = splitOnUnquotedPipe('echo hello');
    expect(result).toEqual(['echo hello']);
  });

  it('handles simple pipe', () => {
    const result = splitOnUnquotedPipe('echo hello | grep pattern');
    expect(result).toEqual(['echo hello', 'grep pattern']);
  });

  it('handles pipe in single quotes - grep -E pattern', () => {
    const result = splitOnUnquotedPipe("grep -E 'api|doc' file");
    expect(result).toEqual(["grep -E 'api|doc' file"]);
  });

  it('handles pipe in double quotes', () => {
    const result = splitOnUnquotedPipe('grep -i "api\\|doc" | head');
    expect(result).toEqual(['grep -i "api\\|doc"', 'head']);
  });

  it('handles pipe in double quotes with spaces', () => {
    const result = splitOnUnquotedPipe('grep "a|b" | head');
    expect(result).toEqual(['grep "a|b"', 'head']);
  });

  it('handles complex pipe in quotes case from the issue', () => {
    const result = splitOnUnquotedPipe(`curl url | grep -E '(mailto:|api\\.|inbox)' | head`);
    expect(result).toEqual([`curl url`, `grep -E '(mailto:|api\\.|inbox)'`, `head`]);
  });

  it('handles multiple pipes - some quoted, some not', () => {
    const result = splitOnUnquotedPipe(`echo "a|b" | grep "c|d" | cat file`);
    expect(result).toEqual([`echo "a|b"`, `grep "c|d"`, 'cat file']);
  });

  it('handles escaped quote inside single quotes', () => {
    const result = splitOnUnquotedPipe("echo 'it\\'s fine'");
    expect(result).toEqual(["echo 'it\\'s fine'"]);
  });

  it('handles escaped backslash inside single quotes', () => {
    const result = splitOnUnquotedPipe("echo 'test\\\\|case'");
    expect(result).toEqual(['echo \'test\\\\|case\'']);
  });

  it('handles double-quote state surviving pipe', () => {
    const result = splitOnUnquotedPipe('echo "test|pattern" | grep foo');
    expect(result).toEqual(['echo "test|pattern"', 'grep foo']);
  });

  it('handles escaped double-quote inside double quotes', () => {
    const result = splitOnUnquotedPipe('echo "test\\"|still"');
    expect(result).toEqual(['echo "test\\"|still"']);
  });

  it('handles empty segments from pipes', () => {
    const result = splitOnUnquotedPipe('echo || cat file | | grep');
    expect(result).toEqual(['echo', '', 'cat file', '', 'grep']);
  });

  it('handles trailing pipe - preserves empty segment', () => {
    const result = splitOnUnquotedPipe('echo test |');
    expect(result).toEqual(['echo test', '']);
  });

  it('handles leading pipe with trim', () => {
    const result = splitOnUnquotedPipe('| grep test');
    expect(result).toEqual(['', 'grep test']);
  });
});

describe('matchesGlobPattern', () => {
  it('matches ** wildcard across directories', () => {
    expect(matchesGlobPattern('src/index.ts', '**/*.ts')).toBe(true);
    expect(matchesGlobPattern('src/foo/bar.ts', '**/*.ts')).toBe(true);
    expect(matchesGlobPattern('index.ts', '**/*.ts')).toBe(true);
  });

  it('matches single * within a segment', () => {
    expect(matchesGlobPattern('file.ts', '*.ts')).toBe(true);
    expect(matchesGlobPattern('file.js', '*.ts')).toBe(false);
  });

  it('matches ? for single character', () => {
    expect(matchesGlobPattern('file1.ts', 'file?.ts')).toBe(true);
    expect(matchesGlobPattern('file12.ts', 'file?.ts')).toBe(false);
  });

  it('matches prefix paths', () => {
    expect(matchesGlobPattern('src/foo/bar.ts', 'src/**/*.ts')).toBe(true);
    expect(matchesGlobPattern('lib/foo/bar.ts', 'src/**/*.ts')).toBe(false);
  });

  it('rejects non-matching patterns', () => {
    expect(matchesGlobPattern('file.txt', '*.ts')).toBe(false);
    expect(matchesGlobPattern('src/file.js', '**/*.ts')).toBe(false);
  });
});

describe('fuzzyFindUnique', () => {
  it('finds exact match', () => {
    const result = fuzzyFindUnique('hello world', 'world');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.index).toBe(6);
    }
  });

  it('returns not_found for completely missing text', () => {
    const result = fuzzyFindUnique('hello world', 'goodbye');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('not_found');
    }
  });

  it('returns invalid_args for empty oldText', () => {
    const result = fuzzyFindUnique('hello world', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('invalid_args');
    }
  });
});
