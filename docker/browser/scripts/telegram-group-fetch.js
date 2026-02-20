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
const SCROLL_SETTLE_MS = 3000;
const SCROLL_MAX_RETRIES = 5;
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

/**
 * Get the highest data-message-id currently rendered in the DOM.
 * Returns null if no messages are visible.
 */
async function getMaxVisibleId(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('.Message[data-message-id]');
    let max = null;
    for (const el of els) {
      const id = parseInt(el.getAttribute('data-message-id'), 10);
      if (!isNaN(id) && (max === null || id > max)) max = id;
    }
    return max;
  });
}

/**
 * Scroll the chat to the latest messages.
 *
 * Telegram Web A does NOT load new messages on scroll — it loads messages
 * around a "focused message ID". When a chat opens, it focuses on the
 * last-read position. To get the truly latest messages, we must click the
 * "Go to bottom" FAB button, which triggers:
 *   focusLastMessage() → focusMessage() → loadViewportMessages() → API fetch
 *
 * The FAB is identified by its stable icon class `i.icon-arrow-down` inside
 * a <button> with aria-label "Go to bottom". CSS-module classes on the button
 * itself are obfuscated and change every build, so we avoid them.
 *
 * Strategies (in order):
 * 1. Click the "Go to bottom" FAB (icon-arrow-down) — triggers server fetch
 * 2. Click message area + press End key — fallback for keyboard navigation
 * 3. Native mouse.wheel() events — last resort for scroll-based loading
 *
 * Retries up to SCROLL_MAX_RETRIES times. Proceeds gracefully if all fail.
 */
async function scrollToLatest(page, lastSeenId) {
  const lastId = lastSeenId ? parseInt(lastSeenId, 10) : null;
  const dbg = (msg) => console.error(`[scrollToLatest] ${msg}`);

  // Check if we already have new messages visible
  const currentMax = await getMaxVisibleId(page);
  dbg(`lastSeenId=${lastId}, currentMaxVisible=${currentMax}`);
  if (lastId !== null && currentMax !== null && currentMax > lastId) {
    dbg('Already showing new messages, skipping scroll');
    return;
  }

  for (let attempt = 0; attempt < SCROLL_MAX_RETRIES; attempt++) {
    dbg(`Attempt ${attempt + 1}/${SCROLL_MAX_RETRIES}`);

    // Strategy 1: Click the "Go to bottom" FAB button.
    // Telegram Web A renders this inside FloatingActionButtons with a stable
    // icon class (icon-arrow-down). The aria-label varies by locale, so we
    // prefer the icon selector but try aria-label as fallback.
    const fabClicked = await page.evaluate(() => {
      // Primary: find button containing the arrow-down icon
      const icon = document.querySelector('i.icon-arrow-down');
      if (icon) {
        const btn = icon.closest('button');
        if (btn) {
          btn.click();
          return { clicked: true, method: 'icon', ariaLabel: btn.getAttribute('aria-label') || '' };
        }
        // Icon exists but no button parent — click the icon's parent directly
        icon.parentElement?.click();
        return { clicked: true, method: 'icon-parent' };
      }
      // Fallback: aria-label (may be localized)
      const ariaBtn = document.querySelector(
        'button[aria-label="Go to bottom"], button[aria-label="Перейти вниз"]'
      );
      if (ariaBtn) {
        ariaBtn.click();
        return { clicked: true, method: 'aria-label', ariaLabel: ariaBtn.getAttribute('aria-label') || '' };
      }
      return { clicked: false };
    });
    dbg(`FAB click: ${JSON.stringify(fabClicked)}`);

    if (!fabClicked.clicked) {
      // Strategy 2: Click message area to focus it, then press End
      const msgEl = await page.$('.Message[data-message-id]');
      if (msgEl) {
        try {
          await msgEl.click({ force: true });
        } catch { /* ok */ }
      }
      dbg('Pressing End key (after focusing message area)');
      await page.keyboard.press('End');

      // Strategy 3: Native mouse.wheel() — real browser-level input events
      dbg('Dispatching native wheel events');
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(300);
      }
    }

    // Wait for Telegram to fetch and render new messages from the server
    await page.waitForTimeout(SCROLL_SETTLE_MS);

    // Check if we now have messages beyond lastSeenId
    const newMax = await getMaxVisibleId(page);
    dbg(`After attempt: maxVisible=${newMax}`);
    if (lastId !== null && newMax !== null && newMax > lastId) {
      dbg('Success — new messages visible');
      return;
    }

    // If we have no lastSeenId reference, one attempt is enough
    if (lastId === null) return;
  }
  dbg('All retries exhausted, proceeding with what we have');
}

/**
 * Verify the page is still showing the expected chat after navigation.
 * Telegram Web A uses hash-based routing like #-1001234567890.
 */
function verifyChatUrl(currentUrl, expectedUrl) {
  // Extract the peer/channel identifier from both URLs
  // Telegram Web A format: https://web.telegram.org/a/#-1001234567890
  const extractHash = (url) => {
    try {
      const hash = new URL(url).hash; // e.g. #-1001234567890
      return hash.replace('#', '');
    } catch {
      return '';
    }
  };
  const expectedPeer = extractHash(expectedUrl);
  if (!expectedPeer) return true; // Can't verify, allow it
  return currentUrl.includes(expectedPeer);
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

    // Verify we're in the right chat (catches redirects to other dialogs)
    if (!verifyChatUrl(page.url(), groupUrl)) {
      outputError(
        'FETCH_FAILED',
        `Chat mismatch: expected ${groupUrl}, got ${page.url()}`
      );
      return;
    }

    // Log memory before heavy operations (helps diagnose Target crashed / OOM)
    const mem = process.memoryUsage();
    console.error(`[mem] rss=${Math.round(mem.rss / 1024 / 1024)}MB heap=${Math.round(mem.heapUsed / 1024 / 1024)}MB`);

    // Scroll to latest messages so virtual scrolling renders new posts
    await scrollToLatest(page, lastSeenId);

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
    const errMsg = err.message || String(err);
    // Include stack trace for crash diagnosis (goes to stderr via outputError's console.error)
    const stack = err.stack ? err.stack.split('\n').slice(0, 5).join(' | ') : '';
    const detail = stack ? `${errMsg} [stack: ${stack}]` : errMsg;
    console.error(`[CRASH] ${detail}`);
    outputError('FETCH_FAILED', errMsg);
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
