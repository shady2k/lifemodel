/** Run one browser step at most `attempts` times; a stopping store can abort it. */
export async function retry(operation, attempts = 3, pauseMs = 1500) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      last = error;
      if (attempt < attempts && pauseMs > 0) {
        await new Promise((done) => setTimeout(done, pauseMs));
      }
    }
  }
  throw last;
}

/** Navigate with a bounded retry: the store or the chat going down aborts a load. */
export async function gotoWithRetry(page, url, options = {}, attempts = 3, pauseMs = 1500) {
  return retry(async (attempt) => {
    await page.goto(url, { waitUntil: 'networkidle', ...options });
    return attempt;
  }, attempts, pauseMs);
}

/** A separate context permits axe's inline instrumentation without weakening the walk. */
export async function scanLogsAxe(browser, page, variant, source, screenshot, prepare) {
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
    if (prepare) await prepare(scan);
    await scan.addScriptTag({ content: source });
    const results = await scan.evaluate(async () => await window.axe.run(document));
    await scan.screenshot({ path: screenshot });
    return results;
  } finally {
    await context.close();
  }
}


/** Measure the rendered throttle text and submit button without script injection. */
export async function measureLogsContrast(page, regionName) {
  return page.evaluate((name) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('contrast: canvas color conversion unavailable');
    const rgba = (color) => {
      context.clearRect(0, 0, 1, 1);
      // Unsupported assignments retain the prior color. Two sentinels detect
      // that silently invalid case while accepting browser-normalized OKLCH.
      context.fillStyle = '#ff0000';
      context.fillStyle = color;
      const first = context.fillStyle;
      context.fillStyle = '#00ff00';
      context.fillStyle = color;
      if (first !== context.fillStyle) throw new Error('contrast: unsupported computed color');
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].map((v, i) => i === 3 ? v / 255 : v);
    };
    const over = (front, back) => [0, 1, 2].map((i) => front[i] * front[3] + back[i] * (1 - front[3])).concat(1);
    const luminance = (color) => color.slice(0, 3).map((v) => {
      const c = v / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const region = [...document.querySelectorAll('section[aria-label]')].find((node) => node.getAttribute('aria-label') === name);
    const button = [...document.querySelectorAll('form button')].at(-1);
    if (!region || !button) throw new Error('contrast: throttle region or Show logs button missing');
    const targets = [...region.querySelectorAll('h2, p, p *')].filter((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()));
    if (!targets.length) throw new Error('contrast: throttle text missing');
    return [...targets.map((node, index) => ({ node, selector: `throttle ${node.tagName.toLowerCase()}[${index}]` })), { node: button, selector: 'form button:last-of-type (Show logs)' }].map(({ node, selector }) => {
      const ancestors = [];
      for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) ancestors.unshift(ancestor);
      let background = [255, 255, 255, 1];
      for (const ancestor of ancestors) {
        const style = getComputedStyle(ancestor);
        if (Number(style.opacity) !== 1 || style.backgroundImage !== 'none' || style.filter !== 'none' || style.mixBlendMode !== 'normal')
          throw new Error(`contrast: ${selector} has unsupported opacity, image, filter or blend`);
        background = over(rgba(style.backgroundColor), background);
      }
      const foreground = over(rgba(getComputedStyle(node).color), background);
      const a = luminance(foreground);
      const b = luminance(background);
      return { selector, foreground: foreground.slice(0, 3), background: background.slice(0, 3), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), required: 4.5 };
    });
  }, regionName);
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
export async function observeUnavailableLogs(page, url, language, attempts = 3, pauseMs = 1500) {
  const origin = new URL(url).origin;
  const words = UNAVAILABLE[language];
  return retry(async () => {
    // A navigation that aborts leaves the response waiter pending; its own
    // catch keeps that promise from rejecting unhandled after the retry.
    const waiting = page.waitForResponse((response) => {
      const target = new URL(response.url());
      return target.origin === origin && target.pathname === '/api/logs'
        && target.searchParams.has('from') && target.searchParams.has('to')
        && target.searchParams.get('status') === '1'
        && response.request().method() === 'GET';
    }, { timeout: 30000 }).catch(() => null);
    // The store being down makes the page poll, so `networkidle` never comes:
    // load the document and wait for the page's own unavailable text below.
    const [response] = await Promise.all([
      waiting,
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }),
    ]);
    if (response === null) throw new Error('the page answered no record request');
    const answer = await response.json();
    if (answer?.state !== 'unavailable' || typeof answer.reason !== 'string' || !answer.reason) {
      throw new Error('the page did not receive an unavailable record answer with a reason');
    }
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
    const records = await page
      .locator('section[aria-live="polite"] ul li:not(:has([role="note"]))')
      .count();
    const empty = (await list.innerText()).includes(words.empty);
    return { reason: answer.reason, text: text.trim(), records, empty };
  }, attempts, pauseMs);
}
