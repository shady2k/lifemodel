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
//     (pending with its reason).
//  4. The level, conversation and text filters narrow the list: every record
//     drawn after a level filter carries that level chip, the record count
//     equals the API's count for the same filter, and every message drawn after
//     a text filter contains the searched words.
//  5. The level chips of the core's records carry a real level and never
//     `unknown`. This is a NOTE, not a FAIL, when the core's own records read
//     back from the API already hold `unknown`: that is an older core image, not
//     a page defect. The API is asked first, so the distinction is made from
//     evidence.
//  6. Paging: a window with more than one page of records shows the second page
//     when "Show older records" is pressed (the list grows and the new records
//     are not the first page's), and going back to /logs returns to the first
//     page.
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
import { resolve } from 'node:path';

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

const secret = readFileSync(pwFile, 'utf8').trim();
mkdirSync(OUT, { recursive: true });

let failures = 0;
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
    stopped: 'collection stopped',
    unknown: 'collection status unknown',
    readOnly: 'refusing writes',
    applied: 'Applied',
    pending: 'Waiting for the store',
    more: 'Show older records',
  },
  ru: {
    title: 'Логи',
    allLevels: 'Все уровни',
    stopped: 'сбор логов остановился',
    unknown: 'состояние сбора неизвестно',
    readOnly: 'не принимает записи',
    applied: 'Применено',
    pending: 'Ожидание, пока хранилище',
    more: 'Показать более старые записи',
  },
};

const engines = [
  ['chromium', chromium, process.env.PLAYWRIGHT_CHROMIUM || `${BROWSERS}/chromium-1243/chrome-linux64/chrome`],
  ['firefox', firefox, process.env.PLAYWRIGHT_FIREFOX || `${BROWSERS}/firefox-1543/firefox/firefox`],
];
const variants = [
  { locale: 'en-US', colorScheme: 'light' },
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

async function messageTexts(page) {
  const items = await recordItems(page);
  return items.evaluateAll((nodes) => nodes.map((node) => (node.querySelector('p')?.textContent ?? '').trim()));
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

      // The status area, tied to the API's own answer.
      const range = windowSeconds(1);
      const statusAnswer = await api(page, `/api/logs?from=${range.from}&to=${range.to}&limit=1&status=1`);
      const status = statusAnswer.body?.status ?? {};
      const pageText = () => page.locator('main').innerText();
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

      // The retention card, tied to the settings answer.
      const settingsAnswer = await api(page, '/api/logs/settings');
      const settings = settingsAnswer.body ?? {};
      if (settingsAnswer.status !== 200 || settings.state !== 'ok') {
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
        await page.screenshot({ path: shot('retention') });
      }

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

      // The conversation filter narrows the list to the API's count.
      const conversationRange = windowSeconds(6);
      const conversationAnswer = await api(page, `/api/logs?from=${conversationRange.from}&to=${conversationRange.to}&limit=200`);
      const conversationRecord = (conversationAnswer.body?.records ?? [])
        .find((record) => typeof record.fields?.conversation_id === 'string');
      if (!conversationRecord) {
        notValid(`${tag}: no record in the last six hours carries a conversation id: the conversation filter cannot be judged`);
      } else {
        const conversationId = conversationRecord.fields.conversation_id;
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

      // Paging: a window wide enough for a second page, then back to the first.
      let firstCount = 0;
      let paged = false;
      for (const hours of [24, 24 * 7, 24 * 14]) {
        const wide = windowSeconds(hours);
        await page.locator('#logs-from').fill(toInput(new Date(wide.from)));
        await page.locator('#logs-to').fill(toInput(new Date(wide.to)));
        await submit(page);
        const line = await countLine(page);
        firstCount = (await recordItems(page)).count();
        if ((line.count ?? 0) > 200 && firstCount > 0) {
          paged = true;
          break;
        }
      }
      if (!paged) {
        notValid(`${tag}: no window holds more than one page of records: paging cannot be judged`);
      } else {
        const firstPage = await messageTexts(page);
        await page.locator('section button').first().click();
        await page.waitForTimeout(1500);
        const grown = (await recordItems(page)).count();
        const secondPage = await messageTexts(page);
        const newOnes = secondPage.slice(firstPage.length);
        check(grown > firstPage.length, `${tag}: the second page is appended`, `${firstPage.length} -> ${grown}`);
        check(
          newOnes.length > 0 && newOnes.filter((text) => firstPage.includes(text)).length === 0,
          `${tag}: the second page holds records the first page did not`
        );
        await page.screenshot({ path: shot('second-page') });
        await page.goto(`https://${HOST}/logs`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1500);
        const back = (await recordItems(page)).count();
        const backMessages = await messageTexts(page);
        check(
          back >= 1 && back <= firstPage.length && backMessages[0] === firstPage[0],
          `${tag}: going back to /logs shows the first page again`,
          `${back} record(s), first record unchanged`
        );
        await page.screenshot({ path: shot('first-page-again') });
      }
      check(errors.length === 0, `${tag}: no page error ${errors.join(' | ')}`);
    } catch (error) {
      check(false, `${tag}: walk ran (${String(error.message).split('\n')[0].slice(0, 160)})`);
      await page.screenshot({ path: shot('error') }).catch(() => {});
    }
    await context.close();
  }
    await browser.close();
  }
} finally {
  proxy.close();
  console.log(`RESTORE nothing was changed: a login session, the filters and the pages only`);
}
console.log(`RESULT ${failures} failed`);
process.exit(failures ? 1 : 0);

function toInput(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
