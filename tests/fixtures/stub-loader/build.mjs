// The real loader is TypeScript and compiles to dist/ with its own tsconfig.
// This stub has no types to compile, so its build is the same shape and no
// more: src/ in, dist/ out.
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('src', 'dist', { recursive: true });
