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
const { waitForReady } = require('./wait-ready');
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_MESSAGES = 50;
const NAV_TIMEOUT_MS = 30_000;
const EXTRACT_TIMEOUT_MS = 30_000;
const PROFILE_DIR = '/profile';

/**
 * Remove stale Chromium lock files from a persistent profile.
 * @see telegram-group-list.js for explanation
 */
function cleanStaleLocks() {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const p = path.join(PROFILE_DIR, name);
    try { fs.unlinkSync(p); } catch { /* file may not exist */ }
  }
}

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

  // Clean stale locks from previous container runs
  cleanStaleLocks();

  // Wait for host to apply network policy (iptables) before any network access
  await waitForReady();

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
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

    // Wait for SPA to render (Telegram Web A needs time for MTProto sync)
    await page.waitForTimeout(8000);

    // Detect auth failure: URL-based + UI element check
    // Telegram Web A shows QR login at the root URL without redirect
    const currentUrl = page.url();
    const urlIndicatesLogin =
      currentUrl.includes('/auth') ||
      currentUrl.includes('login') ||
      currentUrl.includes('#/login');

    const hasLoginUI = await page.evaluate(() => {
      const text = document.querySelector('#root')?.textContent ?? '';
      return text.includes('Log in to Telegram') || text.includes('QR Code') || text.includes('Log in by phone');
    });

    if (urlIndicatesLogin || hasLoginUI) {
      outputError(
        'NOT_AUTHENTICATED',
        'Not authenticated. Re-authenticate with auth_profile.'
      );
      return;
    }

    // Wait for the message list to appear
    // Telegram Web A uses .Message.message-list-item with data-message-id
    try {
      await page.waitForSelector('.Message[data-message-id]', {
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
    // Telegram Web A: .Message[data-message-id] with .text-content for text,
    // .sender-title for author, .message-time for timestamp.
    // Note: .MessageMeta (containing .message-time) is INSIDE .text-content,
    // so we must strip it before reading text to avoid time contamination.
    const messages = await page.evaluate(({ maxMsgs, lastId }) => {
      const results = [];

      const messageElements = document.querySelectorAll('.Message[data-message-id]');
      const elements = Array.from(messageElements).slice(-maxMsgs);

      for (const el of elements) {
        const id = el.getAttribute('data-message-id') || '';
        if (!id) continue;

        // Skip messages we've already seen
        if (lastId && parseInt(id, 10) <= parseInt(lastId, 10)) continue;

        // Extract text, stripping the embedded MessageMeta (time) span
        const textEl = el.querySelector('.text-content');
        let text = '';
        if (textEl) {
          const clone = textEl.cloneNode(true);
          clone.querySelectorAll('.MessageMeta').forEach(m => m.remove());
          text = clone.textContent.trim();
        }

        const timeEl = el.querySelector('.message-time');
        const date = timeEl
          ? timeEl.getAttribute('datetime') || timeEl.getAttribute('title') || timeEl.textContent.trim()
          : '';

        const fromEl = el.querySelector('.sender-title');
        const from = fromEl ? fromEl.textContent.trim() : '';

        results.push({ id, text, date, from });
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
