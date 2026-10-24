/** Host access guard: resolve existing ancestors too, including dangling links. */
import fs from 'node:fs';
import path from 'node:path';
import { safeRelativePath } from '../src/ports/task-agent-validation.mjs';
export function realPathWithin(root, relative, allowMissing = false) {
  if (!safeRelativePath(relative)) throw new Error('unsafe host relative path');
  const base = fs.realpathSync(root);
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    try {
      fs.lstatSync(current); // Do not treat a dangling symlink as a missing file.
      current = fs.realpathSync(current);
    } catch (error) {
      if (!allowMissing || error.code !== 'ENOENT') throw error;
      // realpath failed on a dangling link: it is not a new cache path.
      try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('host path symlink escape'); }
      catch (missing) { if (missing.code !== 'ENOENT') throw missing; }
    }
    if (current !== base && !current.startsWith(base + path.sep)) throw new Error('host path escapes root');
  }
  return current;
}
