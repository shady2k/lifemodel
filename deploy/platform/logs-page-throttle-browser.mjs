// Real-browser throttle evidence: the API and the visible row share one fixed range.
import { gotoWithRetry, scanLogsAxe, measureLogsContrast } from './logs-page-browser.mjs';
import { findDiscardedWindow, waitForThrottle, throttleRowText } from './logs-page-throttle.mjs';
import { axeSummary } from './logs-page-records.mjs';

const inputTime = (time) => {
  const date = new Date(time);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/** Plant once, then wait at most 180 s for a complete positive-discard API window. */
export async function prepareThrottle(read, launch) {
  const from = Math.floor(Date.now() / 60000) * 60000;
  const task = await launch();
  if (!task?.pod) return { reason: 'the high-rate core-owned task writer produced no verified pod' };
  // Include the writer's remaining 30 s and reducer expiry, even if launch returns early.
  const range = { from, to: Math.ceil(Date.now() / 60000) * 60000 + 120000 };
  const result = await waitForThrottle((remaining) => read(range, remaining), task, { boundMs: 180000 });
  return result.window ? { task, range, window: result.window } : { reason: result.reason };
}

/** Read the page's own first-page response, then check its exact translated row. */
export async function drawThrottle(page, url, evidence, language) {
  await gotoWithRetry(page, url);
  await page.locator('section[aria-busy="false"]').waitFor({ timeout: 30000 });
  await page.locator('#logs-from').fill(inputTime(evidence.range.from));
  await page.locator('#logs-to').fill(inputTime(evidence.range.to));
  const waiting = page.waitForResponse((response) => {
    const target = new URL(response.url());
    return target.origin === new URL(url).origin && target.pathname === '/api/logs'
      && response.request().method() === 'GET'
      && Number(target.searchParams.get('from')) === evidence.range.from
      && Number(target.searchParams.get('to')) === evidence.range.to
      && Number(target.searchParams.get('offset') ?? '0') === 0;
  }, { timeout: 30000 });
  // Keep the waiter observed even when a click fails.
  const [response] = await Promise.all([waiting, page.locator('form button').last().click()]);
  const answer = await response.json();
  // Reuse the originally evidenced complete window, not a later arrival.
  const window = findDiscardedWindow({ ...answer, throttle: {
    ...answer.throttle, windows: answer.throttle?.windows?.filter((entry) =>
      entry.start === evidence.window.start && entry.end === evidence.window.end),
  } }, evidence.task);
  if (!window) throw new Error('the page API returned no complete positive-discard window for the task');
  const text = throttleRowText(window, language);
  const section = page.getByRole('region', {
    name: language === 'ru' ? 'Ограничение логов подов задач' : 'Task pod throttling', exact: true,
  });
  const row = section.locator('p').filter({ hasText: text }).first();
  await row.waitFor({ state: 'visible', timeout: 30000 });
  if ((await row.innerText()).replace(/\s+/g, ' ').trim() !== text.replace(/\s+/g, ' ').trim())
    throw new Error('the drawn throttle identity, window or discarded count differs from the API');
  await row.scrollIntoViewIfNeeded();
  // A screenshot must actually contain the count, not just a row below the viewport.
  const box = await row.boundingBox();
  const viewport = page.viewportSize();
  if (!box || !viewport || box.y < 0 || box.y + box.height > viewport.height)
    throw new Error('the discarded count is outside the screenshot viewport');
  return { window, range: evidence.range, text };
}

/** Ordinary CSP screenshot plus a separate axe/contrast scan of the same state. */
export async function proveThrottle(browser, page, options) {
  const { url, evidence, language, variant, axeSource, screenshot } = options;
  const observed = await drawThrottle(page, url, evidence, language);
  const ordinaryContrast = await measureLogsContrast(page, language === 'ru' ? 'Ограничение логов подов задач' : 'Task pod throttling', { hover: true });
  await page.screenshot({ path: screenshot });
  if (!axeSource) throw new Error('axe-core is unavailable; throttle readability is NOT VALID');
  let measured;
  const results = await scanLogsAxe(browser, page, {
    ...variant, viewport: { width: 1280, height: 900 },
  }, axeSource, screenshot.replace(/\.png$/, '-axe.png'), async (scan) => {
    const scanned = await drawThrottle(scan, url, evidence, language);
    if (scanned.window.start !== observed.window.start || scanned.window.end !== observed.window.end
      || scanned.window.discarded !== observed.window.discarded)
      throw new Error('the axe context received a different throttle window/count');
    measured = await measureLogsContrast(scan, language === 'ru' ? 'Ограничение логов подов задач' : 'Task pod throttling');
  });
  const violations = axeSummary(results);
  const contrast = results.passes?.some((rule) => rule.id === 'color-contrast');
  const incomplete = results.incomplete?.filter((rule) => rule.id === 'color-contrast') ?? [];
  const low = [...ordinaryContrast, ...measured].filter((sample) => !sample.exempt && (!Number.isFinite(sample.ratio) || sample.ratio < sample.required));
  const diagnostics = JSON.stringify({ axeContrastPass: Boolean(contrast), ordinary: ordinaryContrast, scan: measured, incomplete: incomplete.map((rule) => ({ id: rule.id, targets: rule.nodes?.flatMap((node) => node.target ?? []) ?? [] })) });
  if (violations.length || low.length || incomplete.length)
    throw new Error(`throttle axe/contrast not proved: ${JSON.stringify(low.map(({ selector, ratio, required }) => ({ selector, ratio, required })))}; axe=${JSON.stringify(violations)}; ${diagnostics}`);
  return { ...observed, contrast: { ordinary: ordinaryContrast, scan: measured } };
}
