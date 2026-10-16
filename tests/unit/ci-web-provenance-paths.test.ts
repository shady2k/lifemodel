import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../../scripts/ci-web-provenance-paths.sh', import.meta.url));
function selected(...paths: string[]): string {
  return execFileSync('sh', [script], { input: `${paths.join('\n')}\n`, encoding: 'utf8' }).trim();
}

describe('web provenance CI path classification', () => {
  it.each([
    ['component-only', ['web/kit/components/ui/button.tsx']],
    ['theme-only', ['web/kit/theme.css']],
    ['lock-only', ['web/kit/registry-lock/manifest.json']],
    ['generator-only', ['scripts/shadcn-add.sh']],
    ['config-only', ['web/app/vite.config.ts']],
    ['Vitest config', ['vitest.config.ts']],
    ['TypeScript app config', ['web/app/tsconfig.json']],
  ])('%s selects provenance', (_name, changed) => {
    expect(selected(...changed)).toBe('web_app=true');
  });
  it('does not select provenance for unrelated paths', () => {
    expect(selected('src/core/agent.ts', 'docs/architecture.md')).toBe('web_app=false');
  });
});
