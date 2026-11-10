/** WALK-LOGS-PAGE (ADR-016 §4, §5; PRA-001): the browser walk cannot run on
 * this box (playwright-core and its browsers belong to the caller), so these
 * checks hold its contract: both engines, both languages, a screenshot per
 * state, the API read before the screen, and the password never printed.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const WALK = 'deploy/platform/logs-page-walk.mjs';

function source(): string {
  return readFileSync(WALK, 'utf8');
}

describe('the browser walk', () => {
  it.each(['client-error', 'client-close', 'up-error', 'up-close'])(
    'cleans up both CONNECT peers on %s without an unhandled socket error',
    (event) => {
      const socket = () =>
        Object.assign(new EventEmitter(), {
          destroyed: false,
          destroy() {
            this.destroyed = true;
          },
          write() {},
          pipe() {},
        });
      const client = socket();
      const up = socket();
      let accept!: (peer: typeof client) => void;
      let connected!: () => void;
      const text = source();
      const proxy = text.slice(
        text.indexOf('const proxy = net.createServer'),
        text.indexOf('await new Promise((ready) => proxy.listen')
      );
      runInNewContext(proxy, {
        HOST: 'boot-example.local',
        TARGET: '127.0.0.1',
        net: {
          createServer(handler: typeof accept) {
            accept = handler;
          },
          connect(_port: number, _host: string, ready: () => void) {
            connected = ready;
            return up;
          },
        },
      });
      accept(client);
      client.emit('data', Buffer.from('CONNECT boot-example.local:443 HTTP/1.1\r\n\r\n'));
      connected();
      const [peer, kind] = event.split('-');
      const emitter = peer === 'client' ? client : up;
      const other = peer === 'client' ? up : client;
      expect(() =>
        emitter.emit(kind, Object.assign(new Error('connection reset'), { code: 'EPIPE' }))
      ).not.toThrow();
      expect(other.destroyed).toBe(true);
    }
  );

  it('parses as an ES module', () => {
    const result = spawnSync('node', ['--check', WALK], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('names its walk, its row and the practice it serves', () => {
    const header = source().split('\n').slice(0, 60).join('\n');
    expect(header).toContain('WALK-LOGS-PAGE');
    expect(header).toMatch(/ADR-016/);
    expect(header).toContain('PRA-001');
    expect(header).toMatch(/Chromium/);
    expect(header).toMatch(/Firefox/);
  });

  it('walks both engines in both languages and both themes', () => {
    const text = source();
    expect(text).toContain('chromium');
    expect(text).toContain('firefox');
    expect(text).toContain("locale: 'en-US'");
    expect(text).toContain("locale: 'ru-RU'");
    expect(text).toContain('colorScheme');
    // Four variants per engine: en/ru in light and dark.
    const variants = text.slice(text.indexOf('const variants'), text.indexOf('async function api'));
    expect((variants.match(/colorScheme:/g) ?? []).length).toBe(4);
    expect((variants.match(/'en-US'/g) ?? []).length).toBe(2);
    expect((variants.match(/'ru-RU'/g) ?? []).length).toBe(2);
  });

  it('judges the page with axe, and the stopped store and the off case with kubectl', () => {
    const text = source();
    expect(text).toContain('axe-core');
    expect(text).toContain('axeSummary(');
    expect(text).toContain(': the page is axe-clean');
    expect(text).toContain("'deployment', ENGINE_STORES, 0");
    expect(text).toContain('CORE_STATEFULSET, 0');
    expect(text).toContain("'/api/logs without a session refuses'");
    expect(text).toContain('every module the API lists is in the filter');
    expect(text).toContain('a range with no match shows an empty answer');
    expect(text).toContain('one record expands to its fields');
    expect(text).toContain('the eviction notice states the space in MiB');
  });

  it('takes a screenshot of every state it asserts', () => {
    const text = source();
    for (const state of [
      'page',
      'retention',
      'level-filter',
      'conversation-filter',
      'text-filter',
      'second-page',
      'first-page-again',
    ]) {
      expect(text).toContain(`shot('${state}')`);
    }
  });

  it('reads the API before judging the screen', () => {
    const text = source();
    expect(text).toContain('/api/logs?from=');
    expect(text).toContain('/api/logs/settings');
    // The level question is settled from the core's own records first.
    expect(text).toContain('module=core');
  });

  it('treats an older core image as a NOTE, never as a page defect', () => {
    const text = source();
    const section = text.slice(
      text.indexOf('module=core'),
      text.indexOf('The conversation filter')
    );
    expect(section).toContain('unknown');
    expect(section).toMatch(/note\(/);
    expect(section).not.toMatch(/check\(coreLevels/);
  });

  it('awaits every page helper, so a locator is never read off its promise', () => {
    const lines = source().split('\n');
    for (const name of [
      'api',
      'fillFilter',
      'submit',
      'recordItems',
      'countLine',
      'messageTexts',
    ]) {
      for (const [index, line] of lines.entries()) {
        if (!line.includes(`${name}(`)) continue;
        if (new RegExp(`^\\s*(async )?function ${name}\\(`).test(line)) continue;
        expect(line, `line ${index + 1}: ${line.trim()}`).toContain(`await ${name}(`);
      }
    }
    // `await recordItems(page).count()` reads the count off the promise.
    expect(source()).not.toMatch(/recordItems\(page\)\.cou?nt/);
    for (const name of ['recordIdentities']) {
      for (const [index, line] of lines.entries()) {
        if (!line.includes(`${name}(`)) continue;
        if (new RegExp(`^\\s*(async )?function ${name}\\(`).test(line)) continue;
        expect(line, `line ${index + 1}: ${line.trim()}`).toContain(`await ${name}(`);
      }
    }
  });

  it('awaits every async locator method it calls', () => {
    const lines = source().split('\n');
    const methods =
      'count|textContent|isVisible|getAttribute|inputValue|innerText' +
      '|allTextContents|evaluateAll';
    const call = new RegExp(`\\.(${methods})\\(`);
    for (const [index, line] of lines.entries()) {
      if (!call.test(line)) continue;
      // A promise the async helper returns is awaited by whoever calls it.
      if (line.trim().startsWith('return ')) continue;
      expect(line, `line ${index + 1}: ${line.trim()}`).toContain('await ');
    }
  });

  it('never calls an async locator method on an awaited promise instead of its value', () => {
    const text = source();
    const methods =
      /^\.(count|textContent|isVisible|getAttribute|inputValue|innerText|allTextContents|evaluateAll)\(/;
    const found: string[] = [];
    for (let at = text.indexOf('(await '); at >= 0; at = text.indexOf('(await ', at + 1)) {
      // `await (await recordItems(page)).count()` awaits the call; `(await
      // recordItems(page)).count()` awaits the locator and reads a promise.
      if (/await\s+$/.test(text.slice(Math.max(0, at - 8), at))) continue;
      let depth = 0;
      let end = -1;
      for (let index = at; index < text.length; index++) {
        if (text[index] === '(') depth += 1;
        else if (text[index] === ')') {
          depth -= 1;
          if (depth === 0) {
            end = index;
            break;
          }
        }
      }
      if (end >= 0 && methods.test(text.slice(end + 1))) {
        found.push(text.slice(at, end + 12).replace(/\s+/g, ' '));
      }
    }
    expect(found).toEqual([]);
  });

  it("judges a second page by the API count and the page's own button", () => {
    const text = source();
    // The count line counts the records drawn - 200 on every full first page -
    // so it cannot say that the window holds more than one page.
    expect(text).not.toMatch(/line\.count \?\? 0\) > 200/);
    expect(text).toContain("getByRole('button', { name: words.more");
    expect(text).toContain('more.isVisible()');
    // The window's own total comes from the API, with the window the page got.
    expect(text).toMatch(
      /api\(page, `\/api\/logs\?from=\$\{wide\.from\}&to=\$\{wide\.to\}&limit=1`\)/
    );
    expect(text).toContain('the second page adds at most one page');
    expect(text).toContain('the count line follows the drawn records');
  });

  it('judges a cross-page repeat against the store\'s own rows', () => {
    const text = source();
    expect(text).toContain('identityCounts(');
    expect(text).toContain('storedIdentityCounts(');
    expect(text).toContain('overDrawnIdentities(');
    expect(text).toContain('windowRecords(page, pagedWindow)');
    expect(text).toContain('drawn more times than stored');
    expect(text).toContain('cross-page repeat(s) are backed by the store');
  });

  it('judges the freshness line from the status answer the page itself fetched', () => {
    const text = source();
    const section = text.slice(
      text.indexOf('The status area, judged'), text.indexOf('The retention card, tied')
    );
    expect(section).toContain('statusResponse');
    expect(section).toContain('the page\'s own status answer was not seen');
    expect(section).not.toContain('api(page');
    expect(text).toContain("target.searchParams.get('status') === '1'");
    expect(text).not.toContain('/api/logs?from=${range.from}');
  });

  it('compares pages by the record the page draws, never by message text', () => {
    const text = source();
    // A message text repeats every few seconds ("collector heartbeat"), so the
    // identity is the time line, the module chip and the message together.
    expect(text).toContain("from './logs-page-records.mjs'");
    expect(text).toContain('await recordIdentities(page)');
    expect(text).toContain('repeatedRecords(');
    expect(text).toContain('by time, module and message');
    expect(text).not.toMatch(/newOnes/);
    expect(text).not.toMatch(/firstPage\.includes\(text\)/);
  });

  it("judges the reload by the reloaded form's own first-page answer", () => {
    const text = source();
    const section = text.slice(
      text.indexOf('let answered = null;'),
      text.indexOf('first-page-again')
    );
    // The reload goes back to the default window, which ends now: newer records
    // have arrived, so the earlier page cannot be the comparison.
    expect(section).toContain('waitForResponse');
    expect(text).toContain('identityOfAnswer(');
    expect(text).toContain('describeIdentity(');
    expect(section).not.toContain('first record unchanged');
    // The earlier page's first record is not the comparison.
    expect(section).not.toContain('firstPage[0]');
    expect(text).toContain('draws the first page and nothing appended');
    expect(text).toContain('is back to its first-page state');
  });

  it('finds a conversation id by narrowing module by module', () => {
    const text = source();
    expect(text).toContain('/api/logs/modules');
    expect(text).toContain('module=${encodeURIComponent(name)}');
    expect(text).toContain('conversation_id');
    // Not valid only when every module was read and none carried one, and the
    // line says how many were read.
    expect(text).toMatch(/of the \$\{moduleNames\.length\} modules/);
  });

  it("reloads once before believing the retention card's read error", () => {
    const text = source();
    expect(text).toMatch(/retentionErrorLine\(/);
    expect(text).toContain("unavailable: 'could not be read'");
    expect(text).toContain("unavailable: 'Не удалось прочитать настройку хранения'");
    expect(text).toMatch(/reload/i);
    // A persistent error is one failure that quotes the page, never three
    // number failures and never a silent pass.
    expect(text).toContain('the retention card reads the retention setting');
  });

  it('retries an aborted navigation and keeps one engine from ending the run', () => {
    const text = source();
    expect(text).toContain('gotoWithRetry(');
    // Every navigation goes through the bounded retry, never a bare page.goto.
    expect(text).not.toMatch(/\bpage\.goto\(/);
    // The stopped store's own navigation is retried inside its observer too.
    expect(text).toContain('observeUnavailableLogs(');
    // One engine's failure is a FAIL line and the next engine still runs.
    expect(text).toContain('the engine walk ran');
    expect(text).toContain('the stopped-store page ran');
  });

  it("compares a filter count with the API over the page form's own window", () => {
    const text = source();
    expect(text).toContain('pageWindow(');
    expect(text).toContain('formWindow(');
    expect(text).toContain('from=${held.from}&to=${held.to}');
    // The module and conversation checks read the form after the submit, not
    // the walk's own earlier range.
    expect(text).not.toContain('from=${range.from}&to=${range.to}&module=');
  });

  it('reports an axe violation by rule id, impact and node selector', () => {
    const text = source();
    expect(text).toContain('rule.impact');
    expect(text).toContain('rule.targets');
    // The failure summary carries page text; it is never printed.
    expect(text).not.toContain('failureSummary');
  });

  it('prints a RESTORE line and exits on the failure count', () => {
    const text = source();
    expect(text).toMatch(/finally\s*\{/);
    expect(text).toContain('RESTORE');
    expect(text).toContain('process.exit(failures ? 1 : 0)');
  });

  it('never prints the password and takes it from a file', () => {
    const text = source();
    expect(text).toContain('readFileSync(pwFile');
    expect(text).not.toMatch(/console\.log\([^)]*secret/);
  });
});
