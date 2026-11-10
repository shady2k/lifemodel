/** A separate context permits axe's inline instrumentation without weakening the walk. */
export async function scanLogsAxe(browser, page, variant, source, screenshot) {
  const url = page.url();
  const storageState = await page.context().storageState();
  const values = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...variant,
    bypassCSP: true,
    storageState,
  });
  try {
    await context.addInitScript(({ origin, values }) => {
      if (location.origin === origin) {
        for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
      }
    }, { origin: new URL(url).origin, values });
    const scan = await context.newPage();
    await scan.goto(url, { waitUntil: 'networkidle' });
    await scan.locator('section[aria-busy="false"]').waitFor({ timeout: 30000 });
    await scan.addScriptTag({ content: source });
    const results = await scan.evaluate(async () => await window.axe.run(document));
    await scan.screenshot({ path: screenshot });
    return results;
  } finally {
    await context.close();
  }
}

// These are the rendered Logs.tsx translations, not a match on the page title.
const UNAVAILABLE = {
  en: {
    label: 'The log store did not answer. Reason:',
    empty: 'No records in this range.',
    reasons: {
      timeout: 'the request timed out',
      connection_refused: 'the connection was refused',
      unreachable: 'the store could not be reached',
      read_only: 'the store is refusing writes (read-only)',
      http_error: 'the store answered with an error',
      invalid_response: 'the store answered with an unreadable response',
    },
  },
  ru: {
    label: 'Хранилище логов не ответило. Причина:',
    empty: 'В этом диапазоне записей нет.',
    reasons: {
      timeout: 'истекло время ожидания',
      connection_refused: 'соединение отклонено',
      unreachable: 'хранилище недоступно',
      read_only: 'хранилище не принимает записи (только чтение)',
      http_error: 'хранилище ответило ошибкой',
      invalid_response: 'хранилище ответило нечитаемым ответом',
    },
  },
};

/** Observe the navigation's own record answer before judging its rendered status. */
export async function observeUnavailableLogs(page, url, language) {
  const origin = new URL(url).origin;
  const [response] = await Promise.all([
    page.waitForResponse((response) => {
      const target = new URL(response.url());
      return target.origin === origin && target.pathname === '/api/logs'
        && target.searchParams.has('from') && target.searchParams.has('to')
        && target.searchParams.get('status') === '1'
        && response.request().method() === 'GET';
    }, { timeout: 30000 }),
    page.goto(url, { waitUntil: 'networkidle' }),
  ]);
  const answer = await response.json();
  if (answer?.state !== 'unavailable' || typeof answer.reason !== 'string' || !answer.reason) {
    throw new Error('the page did not receive an unavailable record answer with a reason');
  }
  const words = UNAVAILABLE[language];
  const reasonText = words.reasons[answer.reason] ?? words.reasons.unreachable;
  await page.waitForFunction(({ label, reason }) => {
    const list = document.querySelector('section[aria-live="polite"]');
    return list?.getAttribute('aria-busy') === 'false'
      && [...document.querySelectorAll('[role="status"]')].some((node) => {
        const text = node.textContent ?? '';
        return text.includes(label) && text.includes(reason);
      });
  }, { label: words.label, reason: reasonText }, { timeout: 30000 });
  const text = await page.getByRole('status').filter({ hasText: words.label }).first().innerText();
  const list = page.locator('section[aria-live="polite"]');
  const records = await page.locator('section[aria-live="polite"] ul li:not([role="note"])').count();
  const empty = (await list.innerText()).includes(words.empty);
  return { reason: answer.reason, text: text.trim(), records, empty };
}
