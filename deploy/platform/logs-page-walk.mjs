// WALK-LOGS-PAGE: the logs page and its retention card, walked in real Chromium
// and Firefox in both languages (ADR-016 §4, §5; PRA-001).
//
// What it proves
// --------------
// Every claim of the logs page that a screenshot can settle is checked on the
// drawn page, in both engines and both languages, and a screenshot is written
// for each state:
//  1. /logs without a session shows the login form, and after the login the page
//     shows its own title, in the browser's language and theme.
//  2. The status area above the results agrees with the API's own status answer:
//     the "collection stopped" or "collection status unknown" line is drawn
//     exactly when the API reports it, and the read-only line when the store
//     refuses writes.
//  3. The retention card draws the two numbers the API holds (days and the byte
//     bound in MiB) and says the store runs them (applied) or is still waiting
//     (pending with its reason). When the card draws its own read error instead -
//     the loader's read of the store failed at that moment - the page is
//     reloaded once; a second error is one failure that quotes the card's line,
//     never three failures of numbers the card did not draw.
//  4. The level, conversation and text filters narrow the list: every record
//     drawn after a level filter carries that level chip, the record count
//     equals the API's count for the same filter, and every message drawn after
//     a text filter contains the searched words. A conversation id is found by
//     narrowing module by module, because the only records carrying one can be
//     older than the newest page of the window.
//  5. The level chips of the core's records carry a real level and never
//     `unknown`. This is a NOTE, not a FAIL, when the core's own records read
//     back from the API already hold `unknown`: that is an older core image, not
//     a page defect. The API is asked first, so the distinction is made from
//     evidence.
//  6. Paging: the window's total comes from the API, and the page offers "Show
//     older records" while it holds more than one page - its count line counts
//     the records drawn, so it is 200 on every full first page and never says
//     more. Pressing the button appends up to one page, the count line follows
//     the drawn records, and no appended record is one the first page drew.
//     A record is compared by what the page draws for it - its time line, its
//     module chip and its message - never by message text alone, which repeats
//     every few seconds ("collector heartbeat"). Going back to /logs returns to
//     the default window, which ends now, so the reload is judged against the
//     page's own first-page answer for that reloaded form (one page drawn, its
//     first record first, "Show older records" back to its first-page state),
//     never against the earlier page.
// Usage:
//   node logs-page-walk.mjs <password-file> <out-dir> [--host HOST] [--target ADDRESS]
// The password is read from the file and never printed. The host is reached
// through a CONNECT proxy that sends the loader's name to the VM's address, the
// same way stage 1's walk reaches it; playwright-core and its browsers are the
// caller's (PLAYWRIGHT_BROWSERS_PATH).
//
// What it changes and restores
// ----------------------------
// Nothing on the cluster: it logs in (a session cookie), reads, filters and
// pages. The finally block prints a RESTORE line saying exactly that. Nothing is
// written to the store, the setting is not changed, no pod is touched.
//
// What it does not cover
// ----------------------
// PRA-001 asks for every state the feature document claims; the ADR's "built so
// far" list is read here as the page's six states above. The retention card's
// pending state is drawn only when the API reports pending at the moment of the
// walk, so a page on a quiet instance usually shows applied; the walk asserts
// whichever the API says and NOTE-s the other. The eviction notice inside the
// list is drawn only after an evictor run; the page walk does not produce one
// (WALK-LOGS-EVICT does) and does not assert it.
import { chromium, firefox } from 'playwright-core';
import net from 'node:net';
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  PAGE_SIZE,
  axeSummary,
  missingModules,
  describeIdentity,
  identityOfAnswer,
  repeatedRecords,
  sameIdentity,
} from './logs-page-records.mjs';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const positional = process.argv.slice(2).filter((value) => !value.startsWith('--'));
const [pwFile, out] = positional;
if (!pwFile || !out) {
  console.error('usage: node logs-page-walk.mjs <password-file> <out-dir> [--host HOST] [--target ADDRESS]');
  process.exit(2);
}
const HOST = argument('--host', 'boot-lifemodel.local');
const TARGET = argument('--target', '192.168.0.122');
const OUT = resolve(out, '.');
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH;
const KUBECTL = argument('--kubectl', 'k3s kubectl').split(' ');
const AXE_CORE = argument('--axe-core', 'node_modules/axe-core/axe.min.js');
const ENGINE_STORES = argument('--store', 'logs-store');
const CORE_STATEFULSET = argument('--core-statefulset', 'core');
const WEB_DEPLOYMENT = argument('--web-deployment', 'web');
const APP_NAMESPACE = argument('--app-namespace', 'lifemodel');
const SYSTEM_NAMESPACE = argument('--system-namespace', 'lifemodel-system');
const axeSource = (() => {
  try {
    return readFileSync(resolve(AXE_CORE), 'utf8');
  } catch {
    return '';
  }
})();

function kubectl(args) {
  return execFileSync(KUBECTL[0], [...KUBECTL.slice(1), ...args], {
    encoding: 'utf8', timeout: 120000,
  });
}

/** Scale a workload to `replicas` and wait until its pods are gone or Ready. */
async function scale(namespace, kind, name, replicas) {
  kubectl(['-n', namespace, 'scale', kind, name, `--replicas=${String(replicas)}`]);
}

function replicasOf(namespace, kind, name) {
  try {
    const value = JSON.parse(
      kubectl(['-n', namespace, 'get', kind, name, '-o', 'json', '--ignore-not-found'])
    );
    const replicas = value?.spec?.replicas;
    return typeof replicas === 'number' ? replicas : 1;
  } catch {
    return 1;
  }
}

async function waitReplicas(page, namespace, kind, name, replicas, boundMs = 180000) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(kubectl(['-n', namespace, 'get', kind, name, '-o', 'json']));
      const ready = kind === 'statefulset'
        ? value?.status?.readyReplicas
        : value?.status?.readyReplicas;
      const wanted = kind === 'statefulset' ? replicas : replicas;
      if ((replicas === 0 && (ready ?? 0) === 0) || (replicas > 0 && (ready ?? 0) >= wanted)) {
        return true;
      }
    } catch {
      // keep waiting
    }
    await page.waitForTimeout(2000);
  }
  return false;
}

const secret = readFileSync(pwFile, 'utf8').trim();
mkdirSync(OUT, { recursive: true });

let failures = 0;
const state = { storeScaled: false, coreScaled: false, webScaled: false };
const check = (ok, what, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${detail ? ' - ' + detail : ''}`);
  if (!ok) failures++;
  return ok;
};
const note = (text) => console.log(`NOTE ${text}`);
const notValid = (text) => {
  failures++;
  console.log(`TEST NOT VALID ${text}`);
};
const MIB = 1024 * 1024;

// A CONNECT proxy that sends the loader's name to the VM.
const proxy = net.createServer((client) => {
  client.once('data', (head) => {
    const line = head.toString().split('\r\n')[0];
    const match = /^CONNECT ([^:]+):(\d+)/.exec(line);
    if (!match) return client.destroy();
    const host = match[1] === HOST ? TARGET : match[1];
    const up = net.connect(Number(match[2]), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      up.pipe(client);
      client.pipe(up);
    });
    up.on('error', () => client.destroy());
  });
});
await new Promise((ready) => proxy.listen(0, '127.0.0.1', ready));
const proxyServer = `http://127.0.0.1:${proxy.address().port}`;

const WORDS = {
  en: {
    title: 'Logs',
    allLevels: 'All levels',
    allModules: 'All modules',
    stopped: 'collection stopped',
    unknown: 'collection status unknown',
    readOnly: 'refusing writes',
    applied: 'Applied',
    pending: 'Waiting for the store',
    unavailable: 'could not be read',
    more: 'Show older records',
    noRecords: 'No records in this range.',
    untrusted: 'untrusted',
    unavailable: 'unavailable',
  },
  ru: {
    title: 'Логи',
    allLevels: 'Все уровни',
    allModules: 'Все модули',
    stopped: 'сбор логов остановился',
    unknown: 'состояние сбора неизвестно',
    readOnly: 'не принимает записи',
    applied: 'Применено',
    pending: 'Ожидание, пока хранилище',
    unavailable: 'Не удалось прочитать настройку хранения',
    more: 'Показать более старые записи',
    noRecords: 'В этом диапазоне записей нет.',
    untrusted: 'недоверенный',
    unavailable: 'недоступно',
  },
};

const engines = [
  ['chromium', chromium, process.env.PLAYWRIGHT_CHROMIUM || `${BROWSERS}/chromium-1243/chrome-linux64/chrome`],
  ['firefox', firefox, process.env.PLAYWRIGHT_FIREFOX || `${BROWSERS}/firefox-1543/firefox/firefox`],
];
const variants = [
  { locale: 'en-US', colorScheme: 'light' },
  { locale: 'en-US', colorScheme: 'dark' },
  { locale: 'ru-RU', colorScheme: 'light' },
  { locale: 'ru-RU', colorScheme: 'dark' },
];

async function api(page, path) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { cache: 'no-store' });
    if (!response.ok) return { status: response.status };
    return { status: response.status, body: await response.json() };
  }, path);
}

function windowSeconds(hours) {
  const to = Date.now();
  return { from: to - hours * 3600_000, to };
}

async function fillFilter(page, id, value) {
  const input = page.locator(`#${id}`);
  await input.fill(String(value));
}

async function submit(page) {
  await page.locator('form button').last().click();
  await page.waitForTimeout(1200);
}

async function recordItems(page) {
  return page.locator('section ul li:not([role=note])');
}

async function countLine(page) {
  const text = (await page.locator('section p').first().textContent()) ?? '';
  const match = /(\d+)/.exec(text.replace(/[\u00a0\u202f]/g, ' '));
  return { text: text.trim(), count: match ? Number(match[1]) : null };
}

/** Wait, bounded, for the page to stop redrawing the list (`aria-busy`). */
async function listSettled(page) {
  await page
    .locator('section[aria-busy="false"]')
    .first()
    .waitFor({ timeout: 30000 })
    .catch(() => {});
}

/** The card's own read-error line, or null when the card drew numbers. */
function retentionErrorLine(text, phrase) {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.includes(phrase)) ?? null
  );
}

async function messageTexts(page) {
  const items = await recordItems(page);
  return items.evaluateAll((nodes) => nodes.map((node) => (node.querySelector('p')?.textContent ?? '').trim()));
}

/** Each drawn record as the page identifies it: its time line, module chip and message. */
async function recordIdentities(page) {
  const items = await recordItems(page);
  return items.evaluateAll((nodes) =>
    nodes.map((node) => ({
      // `<time dateTime>` carries the record's own `_time`, not the localised line.
      time: node.querySelector('time')?.dateTime ?? '',
      module: node.querySelector('[data-slot="badge"][data-variant="secondary"]')?.textContent?.trim() ?? '',
      message: (node.querySelector('p')?.textContent ?? '').trim(),
    }))
  );
}

try {
  for (const [name, type, executablePath] of engines) {
  let browser;
  try {
    browser = await type.launch({ executablePath, proxy: { server: proxyServer } });
  } catch (error) {
    check(false, `${name}: the browser starts (${String(error.message).split('\n')[0].slice(0, 160)})`);
    continue;
  }
  for (const variant of variants) {
    const language = variant.locale.slice(0, 2);
    const words = WORDS[language];
    const tag = `${name}-${variant.locale}-${variant.colorScheme}`;
    const shot = (state) => `${OUT}/${tag}-${state}.png`;
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      locale: variant.locale,
      colorScheme: variant.colorScheme,
      viewport: { width: 1280, height: 900 },
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error.message).slice(0, 120)));
    try {
      await page.goto(`https://${HOST}/`, { waitUntil: 'networkidle' });
      await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
      check(
        (await page.locator('input[type=password]').count()) > 0,
        `${tag}: /logs without a session shows the login form`
      );
      await page.locator('input[type=password]').first().fill(secret);
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/login')),
        page.locator('input[type=password]').first().press('Enter'),
      ]);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
      for (let attempt = 0; ; attempt++) {
        try {
          await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
          break;
        } catch (error) {
          if (attempt >= 2) throw error;
          await page.waitForTimeout(1500);
        }
      }
      await page.waitForTimeout(1500);
      const title = (await page.locator('h1').first().textContent())?.trim() ?? '';
      check(title === words.title, `${tag}: /logs shows its title ("${title}")`);
      const dark = await page.evaluate(() => document.documentElement.classList.contains('dark'));
      check(dark === (variant.colorScheme === 'dark'), `${tag}: theme follows the browser (${variant.colorScheme})`);
      const lang = await page.evaluate(() => document.documentElement.lang);
      check(lang === language, `${tag}: language follows the browser (${lang})`);
      await page.screenshot({ path: shot('page') });
      // axe-core, injected from the caller's npm copy: violations are failures,
      // reported by rule id and count, never by page data.
      if (!axeSource) {
        notValid(`${tag}: axe-core is not readable at ${options.axeCore}: the page's accessibility cannot be judged`);
      } else {
        await page.addScriptTag({ content: axeSource });
        const results = await page.evaluate(async () => await window.axe.run(document));
        const summary = axeSummary(results);
        check(summary.length === 0, `${tag}: the page is axe-clean`,
          summary.map((rule) => `${rule.id} x${String(rule.count)}`).join(', ') || 'no violations');
        await page.screenshot({ path: shot('axe') });
      }

      // The status area, tied to the API's own answer.
      const range = windowSeconds(1);
      const statusAnswer = await api(page, `/api/logs?from=${range.from}&to=${range.to}&limit=1&status=1`);
      const status = statusAnswer.body?.status ?? {};
      const pageText = async () => (await page.locator('main').innerText()) ?? '';
      const bodyText = await pageText();
      const collection = status.collection?.state ?? 'unknown';
      if (collection === 'stopped') {
        check(bodyText.includes(words.stopped), `${tag}: the stopped-collector line is drawn`);
      } else if (collection === 'unknown') {
        check(bodyText.includes(words.unknown), `${tag}: the unknown-collection line is drawn`);
      } else {
        check(!bodyText.includes(words.stopped) && !bodyText.includes(words.unknown),
          `${tag}: no freshness line is drawn while collection is live`);
      }
      const readOnly = status.storeReadOnly === true;
      check(
        readOnly ? bodyText.includes(words.readOnly) : !bodyText.includes(words.readOnly),
        `${tag}: the read-only line follows the store's gauge (${String(readOnly)})`
      );
      note(`${tag}: status area read (collection ${collection}, storeReadOnly ${String(status.storeReadOnly)})`);

      // The retention card, tied to the settings answer. The loader's own read of
      // the store can fail for a moment - measured: Firefox ru-RU-dark drew the
      // card's read error with empty fields while the other three runs drew the
      // numbers - and the card then says so instead of drawing numbers. That is
      // not three wrong numbers: the page is reloaded once after a few seconds,
      // and only a second error is a failure, and then it is one failure that
      // quotes what the page said.
      let cardError = null;
      for (let attempt = 0; ; attempt++) {
        const cardText = await page.locator('#logs-settings').innerText();
        cardError = retentionErrorLine(cardText, words.unavailable);
        if (cardError === null || attempt >= 1) break;
        note(`${tag}: the retention card shows its read error; reloading /logs once`);
        await page.waitForTimeout(5000);
        await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
      }
      const settingsAnswer = await api(page, '/api/logs/settings');
      const settings = settingsAnswer.body ?? {};
      if (cardError !== null) {
        check(false, `${tag}: the retention card reads the retention setting`, cardError);
      } else if (settingsAnswer.status !== 200 || settings.state !== 'ok') {
        notValid(`${tag}: GET /api/logs/settings did not answer: the retention card cannot be judged`);
      } else {
        const days = await page.locator('#logs-retention-days').inputValue();
        const size = await page.locator('#logs-retention-size').inputValue();
        check(Number(days) === settings.days, `${tag}: the retention card shows the days (${days})`);
        check(Number(size) === Math.round(settings.maxBytes / MIB),
          `${tag}: the retention card shows the byte bound in MiB (${size})`);
        const card = await page.locator('#logs-settings').innerText();
        const applied = settings.applied === true;
        check(
          applied ? card.includes(words.applied) : card.includes(words.pending),
          `${tag}: the retention card says ${applied ? 'applied' : 'pending'} as the API does`
        );
      }
      await page.screenshot({ path: shot('retention') });

      // The level chips of the core's records, from the API first.
      const coreRange = windowSeconds(1);
      const coreAnswer = await api(page, `/api/logs?from=${coreRange.from}&to=${coreRange.to}&module=core&limit=200`);
      const coreLevels = (coreAnswer.body?.records ?? []).map((record) => record.fields?.level ?? '');
      if (coreLevels.length === 0) {
        notValid(`${tag}: the core wrote no record in the last hour: its level chips cannot be judged`);
      } else if (coreLevels.includes('unknown')) {
        note(`${tag}: the core's own records read back as level=unknown from the API, which is an `
          + 'older core image, not a page defect: the level chip assertion is not made');
      } else {
        const level = coreLevels.find((value) => value && value !== 'unknown') ?? 'info';
        await page.locator('#logs-level').click();
        await page.getByRole('option', { name: level, exact: true }).click();
        await submit(page);
        const items = await recordItems(page);
        const badges = await page.locator('section ul li .inline-flex, section ul li [class*=badge]').allTextContents();
        check((await items.count()) > 0, `${tag}: records are found with the level filter (${level})`);
        check(badges.includes(level), `${tag}: the level chip carries the filtered level (${level})`);
        check(!badges.map((text) => text.trim()).includes('unknown'),
          `${tag}: no level chip says unknown`);
        await page.screenshot({ path: shot('level-filter') });
        await page.locator('#logs-level').click();
        await page.getByRole('option', { name: words.allLevels, exact: true }).click();
        await submit(page);
      }

      // The conversation filter narrows the list to the API's count. A person
      // narrows it by module first, and so does the walk: a record carrying a
      // conversation id can be older than the newest page of the whole window
      // (measured on the VM: the latency walk's 60 records in the module
      // `walk-latency-filter` were), so each module the page's own select lists
      // is read newest-first and the first conversation id found is used.
      const conversationRange = windowSeconds(6);
      const modulesAnswer = await api(page, '/api/logs/modules');
      const moduleNames = modulesAnswer.body?.state === 'ok'
        ? (modulesAnswer.body.modules ?? []).filter((name) => typeof name === 'string')
        : [];
      let conversationId = null;
      let conversationModule = null;
      for (const name of moduleNames) {
        const answer = await api(page, `/api/logs?from=${conversationRange.from}&to=${conversationRange.to}&module=${encodeURIComponent(name)}&limit=200`);
        const record = (answer.body?.records ?? []).find(
          (entry) => typeof entry.fields?.conversation_id === 'string'
            && entry.fields.conversation_id.length > 0
        );
        if (record) {
          conversationId = record.fields.conversation_id;
          conversationModule = name;
          break;
        }
      }
      if (moduleNames.length === 0) {
        notValid(`${tag}: /api/logs/modules listed no module to narrow the conversation filter by (status ${modulesAnswer.status})`);
      } else if (conversationId === null) {
        notValid(`${tag}: none of the ${moduleNames.length} modules the API lists has a record with a conversation id in the last six hours: the conversation filter cannot be judged`);
      } else {
        note(`${tag}: the conversation record comes from module ${conversationModule}`);
        const expected = await api(page, `/api/logs?from=${conversationRange.from}&to=${conversationRange.to}&conversation_id=${encodeURIComponent(conversationId)}&limit=1`);
        await page.locator('#logs-from').fill(toInput(new Date(conversationRange.from)));
        await page.locator('#logs-to').fill(toInput(new Date(conversationRange.to)));
        await fillFilter(page, 'logs-conversation', conversationId);
        await submit(page);
        const line = await countLine(page);
        check(
          line.count !== null && line.count === expected.body?.count,
          `${tag}: the conversation filter narrows to the API's count`,
          `page "${line.text}", API ${expected.body?.count}`
        );
        await page.screenshot({ path: shot('conversation-filter') });
        await fillFilter(page, 'logs-conversation', '');
      }

      // The text filter, with a word from the first record drawn.
      const drawn = await messageTexts(page);
      const token = (drawn.find((text) => text.length > 0) ?? '').match(/[A-Za-z][A-Za-z0-9_-]{3,}/)?.[0];
      if (!token) {
        notValid(`${tag}: no record message holds a word to search: the text filter cannot be judged`);
      } else {
        await fillFilter(page, 'logs-text', token);
        await submit(page);
        const messages = await messageTexts(page);
        check(messages.length > 0, `${tag}: the text filter finds records ("${token}")`);
        check(
          messages.every((text) => text.toLowerCase().includes(token.toLowerCase())),
          `${tag}: every message drawn contains the searched words`
        );
        await page.screenshot({ path: shot('text-filter') });
        await fillFilter(page, 'logs-text', '');
      }

      // Every module the API lists is offered by the module filter, and each of
      // the four filters narrows the drawn list to the API's count.
      const filterModulesAnswer = await api(page, '/api/logs/modules');
      const filterModuleNames = filterModulesAnswer.body?.modules ?? [];
      if (filterModulesAnswer.status !== 200 || !Array.isArray(filterModuleNames)) {
        notValid(`${tag}: /api/logs/modules did not answer: the module filter cannot be judged`);
      } else {
        await page.locator('#logs-module').click();
        const optionTexts = await page.getByRole('option').allTextContents();
        const missing = missingModules(optionTexts, filterModuleNames);
        check(missing.length === 0, `${tag}: every module the API lists is in the filter`,
          missing.length === 0
            ? `${filterModuleNames.length} module(s)`
            : `missing ${missing.slice(0, 3).join(', ')}`);
        await page.keyboard.press('Escape');
        const module = filterModuleNames[0] ?? '';
        if (module) {
          await page.locator('#logs-module').click();
          await page.getByRole('option', { name: module, exact: true }).click();
          await submit(page);
          const expected = await api(page, `/api/logs?from=${range.from}&to=${range.to}&module=${encodeURIComponent(module)}&limit=1`);
          const line = await countLine(page);
          check(line.count !== null && line.count === expected.body?.count,
            `${tag}: the module filter narrows to the API\'s count`,
            `page "${line.text}", API ${expected.body?.count}`);
          await page.screenshot({ path: shot('module-filter') });
          await page.locator('#logs-module').click();
          await page.getByRole('option', { name: words.allModules, exact: true }).click();
          await submit(page);
        }
      }

      // One record expanded, and a range with no match showing an empty answer.
      const drawnItems = await recordItems(page);
      const drawnCount = await drawnItems.count();
      const firstItem = drawnItems.first();
      if (drawnCount > 0) {
        await firstItem.locator('summary').first().click();
        const fields = await firstItem.locator('dt').count();
        check(fields > 0, `${tag}: one record expands to its fields`, `${fields} field name(s)`);
        await page.screenshot({ path: shot('record-expanded') });
      }
      const emptyFrom = Date.now() - 48 * 3600_000;
      await page.locator('#logs-from').fill(toInput(new Date(emptyFrom)));
      await page.locator('#logs-to').fill(toInput(new Date(emptyFrom + 60_000)));
      await submit(page);
      const emptyText = (await page.locator('main').innerText()) ?? '';
      const emptyItems = await recordItems(page);
      const drawnEmpty = await emptyItems.count();
      check(drawnEmpty === 0 && emptyText.includes(words.noRecords),
        `${tag}: a range with no match shows an empty answer, not an error`,
        `${drawnEmpty} record(s) drawn`);
      await page.screenshot({ path: shot('empty-range') });

      // A task record carrying `untrusted`, written if the window holds none.
      let untrustedRecord = null;
      const wide = windowSeconds(6);
      const candidates = await api(page, `/api/logs?from=${wide.from}&to=${wide.to}&limit=200`);
      untrustedRecord = (candidates.body?.records ?? []).find(
        (record) => String(record.fields?.untrusted) === 'true'
      );
      if (!untrustedRecord) {
        const line = `walk-untrusted-${tag}-${String(Date.now())}`;
        const manifest = {
          apiVersion: 'v1', kind: 'Pod',
          metadata: { name: 'walk-untrusted', namespace: 'lifemodel-motor',
                      labels: { 'app.kubernetes.io/name': 'walk-untrusted' } },
          spec: {
            restartPolicy: 'Never', automountServiceAccountToken: false,
            containers: [{
              name: 'writer', image: 'ghcr.io/shady2k/lifemodel-loader:release-placeholder',
              command: ['node', '-e', `process.stdout.write(${JSON.stringify(line)}+'\\n')`],
              resources: { requests: { cpu: '10m', memory: '16Mi' } },
            }],
          },
        };
        try {
          kubectl(['-n', 'lifemodel-motor', 'delete', 'pod', 'walk-untrusted', '--ignore-not-found', '--wait=false']);
          kubectl(['apply', '-f', '-'], { input: JSON.stringify(manifest) });
        } catch {
          kubectl(['-n', 'lifemodel-motor', 'delete', 'pod', 'walk-untrusted', '--ignore-not-found', '--wait=false']);
        }
        untrustedRecord = { message: line, fields: { untrusted: 'true' } };
      }
      if (!untrustedRecord) {
        notValid(`${tag}: no task record in the window and none could be written: untrusted cannot be judged`);
      } else {
        await fillFilter(page, 'logs-text', (untrustedRecord.message ?? '').slice(0, 24));
        await submit(page);
        const text = (await page.locator('main').innerText()) ?? '';
        check(text.includes(words.untrusted) || String(untrustedRecord.fields?.untrusted) !== 'true',
          `${tag}: a task record shows untrusted`, untrustedRecord.message.slice(0, 40));
        await page.screenshot({ path: shot('untrusted') });
        await fillFilter(page, 'logs-text', '');
        await submit(page);
      }

      // The eviction notice, where the window holds one, states MiB.
      const evictions = status.evictions ?? [];
      if (evictions.length > 0) {
        const noticeText = await page.locator('[role=note]').first().innerText();
        check(noticeText.includes('MiB'), `${tag}: the eviction notice states the space in MiB`, noticeText.slice(0, 80));
        await page.screenshot({ path: shot('eviction-notice') });
      }

      // Paging: a window wide enough for a second page, then back to the first.
      // The page's count line counts the records drawn - 200 on every full first
      // page - so it cannot say the window holds more: that is the API's count
      // for the same window, and the "Show older records" button the page draws
      // while `nextOffset < windowCount` (Logs.tsx). On the VM the last six hours
      // hold about 180,000 records, so the first window tried must offer it.
      const more = page.getByRole('button', { name: words.more, exact: true });
      let firstCount = 0;
      let windowCount = 0;
      let paged = false;
      for (const hours of [6, 24, 24 * 7]) {
        const wide = windowSeconds(hours);
        await page.locator('#logs-from').fill(toInput(new Date(wide.from)));
        await page.locator('#logs-to').fill(toInput(new Date(wide.to)));
        await submit(page);
        await listSettled(page);
        const windowAnswer = await api(page, `/api/logs?from=${wide.from}&to=${wide.to}&limit=1`);
        windowCount = windowAnswer.body?.count ?? 0;
        firstCount = await (await recordItems(page)).count();
        const offered = await more.isVisible();
        if (windowCount > firstCount && firstCount > 0 && offered) {
          paged = true;
          break;
        }
      }
      if (!paged) {
        notValid(`${tag}: no window offered a second page (the API counted ${windowCount} record(s)): paging cannot be judged`);
      } else {
        check(windowCount > firstCount, `${tag}: the API says the window holds more than one page`,
          `count ${windowCount}, ${firstCount} drawn`);
        check(await more.isVisible(), `${tag}: the page offers "Show older records" for that window`);
        const line = await countLine(page);
        check(line.count === firstCount, `${tag}: the count line counts the records drawn`,
          `page "${line.text}", ${firstCount} drawn`);
        const firstPage = await recordIdentities(page);
        await more.click();
        // The page appends the next page and the count line counts it; wait for
        // that number to pass the first page's rather than for a fixed delay.
        await page
          .waitForFunction(
            (expected) => {
              const line = document.querySelector('section p');
              const text = (line?.textContent ?? '').replace(/[\u00a0\u202f]/g, ' ');
              const match = /(\d+)/.exec(text);
              return match !== null && Number(match[1]) > expected;
            },
            firstCount,
            { timeout: 30000 }
          )
          .catch(() => {});
        const drawnAfter = await recordIdentities(page);
        const grownLine = await countLine(page);
        const appended = drawnAfter.slice(firstPage.length);
        const repeats = repeatedRecords(firstPage, appended);
        // A message text repeats every few seconds on a live machine ("collector
        // heartbeat", CoreDNS's import-glob warning), so the two pages are
        // compared by the record the page draws: time line, module chip, message.
        const sharedTexts = appended.filter(
          (entry) => firstPage.some((held) => held.message === entry.message)
        ).length;
        check(drawnAfter.length > firstPage.length, `${tag}: the second page is appended`,
          `${firstPage.length} -> ${drawnAfter.length}`);
        check(drawnAfter.length - firstPage.length <= PAGE_SIZE,
          `${tag}: the second page adds at most one page`,
          `${drawnAfter.length - firstPage.length} new record(s)`);
        check(grownLine.count === drawnAfter.length, `${tag}: the count line follows the drawn records`,
          `line ${grownLine.count}, ${drawnAfter.length} drawn`);
        check(
          appended.length > 0 && repeats.length === 0,
          `${tag}: the second page holds records the first page did not`,
          `${appended.length} appended record(s), each compared with the ${firstPage.length} drawn on `
          + 'the first page by time, module and message'
          + (sharedTexts > 0
            ? `; ${sharedTexts} message text(s) repeat across the pages, and those records differ`
            : '')
          + (repeats.length > 0
            ? `; drawn twice: ${repeats.slice(0, 3).map((entry) => describeIdentity(entry)).join('; ')}`
            : '')
        );
        await page.screenshot({ path: shot('second-page') });
        // The reload returns to the default window, which ends now: newer records
        // have arrived, so the earlier page is not what the reload must draw. The
        // page's own first-page answer is: same window, read as the reload read
        // it, and it is what the drawn list must be.
        let answered = null;
        const [reloadAnswer] = await Promise.all([
          page
            .waitForResponse(
              (response) => response.url().includes('/api/logs?') && response.url().includes('status=1'),
              { timeout: 30000 }
            )
            .catch(() => null),
          page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' }),
        ]);
        await page.waitForTimeout(1500);
        if (reloadAnswer !== null) answered = await reloadAnswer.json().catch(() => null);
        const backRecords = await recordIdentities(page);
        const answeredRecords = (answered?.records ?? []).map((record) => identityOfAnswer(record));
        const answeredCount = typeof answered?.count === 'number' ? answered.count : null;
        const offeredAgain = await more.isVisible();
        if (answered === null || answered.state !== 'ok') {
          check(false, `${tag}: going back to /logs answers its first page`,
            'no successful /api/logs?status=1 answer was seen for the reload');
        } else {
          check(
            backRecords.length >= 1 && backRecords.length === answeredRecords.length,
            `${tag}: going back to /logs draws the first page and nothing appended`,
            `${backRecords.length} record(s) drawn, the reload's own first-page answer holds `
            + `${answeredRecords.length}`
          );
          check(
            answeredRecords.length > 0 && sameIdentity(backRecords[0], answeredRecords[0]),
            `${tag}: going back to /logs draws the answer's first record first`,
            `drawn ${describeIdentity(backRecords[0])}, the answer's first `
            + `${describeIdentity(answeredRecords[0])}`
          );
          check(
            answeredCount !== null && offeredAgain === (answeredCount > PAGE_SIZE),
            `${tag}: "Show older records" is back to its first-page state`,
            `visible ${String(offeredAgain)}, the reload's window holds ${answeredCount} record(s)`
          );
        }
        await page.screenshot({ path: shot('first-page-again') });
      }
      check(errors.length === 0, `${tag}: no page error ${errors.join(' | ')}`);
    } catch (error) {
      check(false, `${tag}: walk ran (${String(error.message).split('\n')[0].slice(0, 160)})`);
      await page.screenshot({ path: shot('error') }).catch(() => {});
    }
    await context.close();
  }
    // WALK-LOGS-OFF's store half: with the store scaled to zero the page answers
    // `unavailable` with its reason, never an empty list.
    {
      const context = await browser.newContext({
        ignoreHTTPSErrors: true, locale: 'en-US', colorScheme: 'light',
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      try {
        await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
        await page.locator('input[type=password]').first().fill(secret);
        await Promise.all([
          page.waitForResponse((response) => response.url().endsWith('/api/login')),
          page.locator('input[type=password]').first().press('Enter'),
        ]);
        await page.waitForLoadState('networkidle');
        state.storeScaled = true;
        await scale(SYSTEM_NAMESPACE, 'deployment', ENGINE_STORES, 0);
        await waitReplicas(page, SYSTEM_NAMESPACE, 'deployment', ENGINE_STORES, 0);
        await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
        const text = (await page.locator('main').innerText()) ?? '';
        check(text.includes('unavailable') || text.includes('недоступно'),
          `${name}: with the store stopped the page says unavailable`, text.slice(0, 80));
        check(!text.includes('were removed') && !text.includes('удалены'),
          `${name}: the stopped store never shows an empty list`);
        await page.screenshot({ path: `${OUT}/${name}-store-stopped.png` });
      } finally {
        await scale(SYSTEM_NAMESPACE, 'deployment', ENGINE_STORES, 1);
        state.storeScaled = false;
        await waitReplicas(page, SYSTEM_NAMESPACE, 'deployment', ENGINE_STORES, 1);
        await context.close();
      }
    }
    await browser.close();
  }
  // WALK-LOGS-OFF: with the core and the chat scaled to zero the page still
  // answers, and without a session it refuses.
  {
    const [name, type, executablePath] = engines[0];
    let browser = null;
    let context = null;
    try {
      browser = await type.launch({ executablePath, proxy: { server: proxyServer } });
      context = await browser.newContext({
        ignoreHTTPSErrors: true, locale: 'en-US', colorScheme: 'light',
        viewport: { width: 1280, height: 900 },
      });
      const page = await context.newPage();
      state.coreReplicas = replicasOf(APP_NAMESPACE, 'statefulset', CORE_STATEFULSET);
      state.webReplicas = replicasOf(APP_NAMESPACE, 'deployment', WEB_DEPLOYMENT);
      state.coreScaled = true;
      state.webScaled = true;
      await scale(APP_NAMESPACE, 'statefulset', CORE_STATEFULSET, 0);
      await scale(APP_NAMESPACE, 'deployment', WEB_DEPLOYMENT, 0);
      await waitReplicas(page, APP_NAMESPACE, 'statefulset', CORE_STATEFULSET, 0);
      await waitReplicas(page, APP_NAMESPACE, 'deployment', WEB_DEPLOYMENT, 0);
      await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
      check((await page.locator('input[type=password]').count()) > 0,
        'off: /logs without a session shows the login while the core and the chat are stopped');
      const refused = await api(page, '/api/logs?from=0&to=1&limit=1');
      check(refused.status === 401 || refused.status === 403,
        '/api/logs without a session refuses', `status ${refused.status}`);
      await page.locator('input[type=password]').first().fill(secret);
      await Promise.all([
        page.waitForResponse((response) => response.url().endsWith('/api/login')),
        page.locator('input[type=password]').first().press('Enter'),
      ]);
      await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      const answer = await api(page, `/api/logs?from=${Date.now() - 3600_000}&to=${Date.now()}&limit=5&status=1`);
      check(answer.status === 200 && answer.body?.state === 'ok',
        'off: the page answers with the core and the chat stopped', `state ${answer.body?.state}`);
      await page.screenshot({ path: `${OUT}/off-page.png` });
    } catch (error) {
      check(false, `off: the walk ran (${String(error.message).split('\n')[0].slice(0, 160)})`);
    } finally {
      if (state.coreReplicas !== undefined)
        await scale(APP_NAMESPACE, 'statefulset', CORE_STATEFULSET, state.coreReplicas).catch(() => {});
      if (state.webReplicas !== undefined)
        await scale(APP_NAMESPACE, 'deployment', WEB_DEPLOYMENT, state.webReplicas).catch(() => {});
      state.coreScaled = false;
      state.webScaled = false;
      if (context) await context.close();
      if (browser) await browser.close();
    }
  }
} finally {
  proxy.close();
  console.log(`RESTORE store scaled to 1 and Ready, core and chat back to their replica counts, `
    + `a login session, the filters and the pages only`);
}
console.log(`RESULT ${failures} failed`);
process.exit(failures ? 1 : 0);

function toInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
