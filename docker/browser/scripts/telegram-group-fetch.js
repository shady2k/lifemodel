/**
 * Telegram Private Group Fetcher
 *
 * Playwright script that reads SCRIPT_INPUTS env, launches a persistent
 * browser context (headless) with a pre-authenticated profile, navigates
 * to a Telegram group URL, and extracts messages.
 *
 * Input:  { profile, groupUrl, lastSeenId?, maxMessages? }
 * Output: { ok, messages: [{id, text, date, from}], latestId }
 *
 * Error codes:
 * - NOT_AUTHENTICATED: redirect to login page detected
 * - FETCH_FAILED: navigation or extraction error
 */

const { chromium } = require('playwright');

const DEFAULT_MAX_MESSAGES = 50;
const NAV_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 15_000;

async function main() {
  const rawInputs = process.env.SCRIPT_INPUTS;
  if (!rawInputs) {
    outputError('INVALID_INPUT', 'SCRIPT_INPUTS environment variable is required');
    return;
  }

  let inputs;
  try {
    inputs = JSON.parse(rawInputs);
  } catch {
    outputError('INVALID_INPUT', 'SCRIPT_INPUTS is not valid JSON');
    return;
  }

  const { groupUrl, lastSeenId, maxMessages = DEFAULT_MAX_MESSAGES } = inputs;

  if (!groupUrl) {
    outputError('INVALID_INPUT', 'groupUrl is required');
    return;
  }

  let context;
  try {
    context = await chromium.launchPersistentContext('/profile', {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
      ],
    });

    const page = context.pages()[0] || await context.newPage();

    // Navigate to the group URL
    await page.goto(groupUrl, {
      waitUntil: 'domcontentloaded',
      timeout: NAV_TIMEOUT_MS,
    });

    // Detect auth failure: if redirected to login page
    const currentUrl = page.url();
    if (
      currentUrl.includes('/auth') ||
      currentUrl.includes('login') ||
      currentUrl.includes('#/login')
    ) {
      outputError(
        'NOT_AUTHENTICATED',
        `Redirected to login page: ${currentUrl}. Re-authenticate with browser:auth.`
      );
      return;
    }

    // Wait for the message list to appear
    try {
      await page.waitForSelector('.message, .Message, [class*="message"]', {
        timeout: EXTRACT_TIMEOUT_MS,
      });
    } catch {
      // Check if we're on a valid page but with no messages
      const bodyText = await page.textContent('body').catch(() => '');
      if (bodyText && (bodyText.includes('no messages') || bodyText.includes('empty'))) {
        outputResult([], null);
        return;
      }
      // Could be auth issue or page structure change
      outputError(
        'FETCH_FAILED',
        `Could not find message elements on page. URL: ${page.url()}`
      );
      return;
    }

    // Extract messages from the DOM
    // Telegram Web A and Web K have different DOM structures — try multiple selectors
    const messages = await page.evaluate(({ maxMsgs, lastId }) => {
      const results = [];

      // Try Telegram Web K selectors first, then Web A
      const messageElements =
        document.querySelectorAll('.message[data-mid]').length > 0
          ? document.querySelectorAll('.message[data-mid]')
          : document.querySelectorAll('[class*="Message"][data-message-id], .bubble[data-mid]');

      const elements = Array.from(messageElements).slice(-maxMsgs);

      for (const el of elements) {
        const id = el.getAttribute('data-mid') || el.getAttribute('data-message-id') || '';
        if (!id) continue;

        // Skip messages we've already seen
        if (lastId && parseInt(id, 10) <= parseInt(lastId, 10)) continue;

        const textEl =
          el.querySelector('.text-content, .message-text, [class*="text-content"]');
        const text = textEl ? textEl.textContent.trim() : '';

        const dateEl = el.querySelector('.time, .message-time, time, [class*="time"]');
        const dateAttr = dateEl
          ? dateEl.getAttribute('datetime') || dateEl.getAttribute('title') || dateEl.textContent.trim()
          : '';

        const fromEl = el.querySelector(
          '.peer-title, .sender-title, .name, [class*="sender"]'
        );
        const from = fromEl ? fromEl.textContent.trim() : '';

        results.push({ id, text, date: dateAttr, from });
      }

      return results;
    }, { maxMsgs: maxMessages, lastId: lastSeenId || null });

    const latestId = messages.length > 0
      ? messages[messages.length - 1].id
      : null;

    outputResult(messages, latestId);
  } catch (err) {
    outputError('FETCH_FAILED', err.message || String(err));
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

function outputResult(messages, latestId) {
  const result = {
    ok: true,
    messages,
    latestId,
  };
  process.stdout.write(JSON.stringify(result));
}

function outputError(code, message) {
  const result = {
    ok: false,
    error: { code, message },
    messages: [],
    latestId: null,
  };
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  outputError('FETCH_FAILED', `Unhandled: ${err.message || String(err)}`);
  process.exit(1);
});
