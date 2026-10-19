// Conservative shell-command inventory for the resolver entrypoints.
// Quoted JS snippets are data. Command substitutions are shell and recurse.
import { accessSync, constants, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function commands(text) {
  const tokens = [];
  const nested = new Set();
  for (const match of text.matchAll(/trap '([^']+)'/g))
    for (const command of commands(match[1])) nested.add(command);
  let word = '';
  const flush = () => {
    if (word) tokens.push(word);
    word = '';
  };
  let doubleQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '#' && !word && !doubleQuoted) {
      while (i < text.length && text[i] !== '\n') i++;
      flush();
      tokens.push(';');
    } else if (c === "'" && !doubleQuoted) {
      i++;
      while (i < text.length && text[i] !== "'") i++;
      word += 'DATA';
    } else if (c === '$' && text[i + 1] === '{') {
      i += 2;
      let depth = 1;
      for (; i < text.length && depth; i++) {
        if (text[i] === '{') depth++;
        if (text[i] === '}') depth--;
      }
      i--;
      word += 'VARIABLE';
    } else if (c === '$' && text[i + 1] === '(') {
      let depth = 1;
      const start = i + 2;
      i += 2;
      for (; i < text.length && depth; i++) {
        if (text[i] === '(') depth++;
        if (text[i] === ')') depth--;
      }
      if (text[start] !== '(')
        for (const cmd of commands(text.slice(start, i - 1))) nested.add(cmd);
      i--;
      word += 'SUBSTITUTION';
    } else if (c === '"') {
      doubleQuoted = !doubleQuoted;
      word += 'DATA';
    } else if (c === '\\') {
      i++;
      if (text[i] !== '\n') word += text[i] ?? '';
    } else if (!doubleQuoted && /\s/.test(c)) {
      flush();
      if (c === '\n') tokens.push(';');
    } else if (c === '&' && /[<>]$/.test(word)) {
      word += c;
    } else if (!doubleQuoted && ';|&{}()'.includes(c)) {
      flush();
      tokens.push(c);
    } else word += c;
  }
  flush();
  const found = nested;
  let start = true;
  const keywords = new Set([
    'if',
    'then',
    'else',
    'elif',
    'while',
    'do',
    '!',
    '{',
    '(',
    ';',
    '|',
    '&',
  ]);
  const endings = new Set(['fi', 'done', '}', ')']);
  const functions = new Set(
    tokens.filter((_, i) => tokens[i + 1] === '(' && tokens[i + 2] === ')')
  );
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (keywords.has(token)) {
      start = true;
      continue;
    }
    if (endings.has(token)) {
      start = false;
      continue;
    }
    if (!start) continue;
    if (/^[A-Za-z_][A-Za-z_0-9]*=/.test(token) || /^\d*[<>]/.test(token)) continue;
    start = false;
    if (token === 'exec') {
      start = true;
      continue;
    }
    if (!functions.has(token)) found.add(token);
  }
  return [...found].filter((command) => !functions.has(command) && !/^\d*[<>]/.test(command));
}
export const builtins = new Set([
  '[',
  'set',
  'shift',
  'printf',
  'echo',
  'exit',
  'true',
  'trap',
  'return',
  ':',
  'break',
]);
export function inventory(script) {
  return readdirSync('deploy/k3s')
    .filter((name) => name.endsWith('.sh') && (!script || script === name))
    .flatMap((name) =>
      commands(readFileSync(`deploy/k3s/${name}`, 'utf8')).filter(
        (command) => !builtins.has(command)
      )
    );
}
if (process.argv[2] === '--path') {
  for (const command of inventory(process.argv[4])) {
    const available = process.argv[3].split(':').some((directory) => {
      try {
        accessSync(join(directory, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
    if (!available)
      throw new Error(`resolver command missing from evaluated unit PATH: ${command}`);
  }
}
