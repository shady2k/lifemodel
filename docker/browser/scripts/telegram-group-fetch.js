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

const DEFAULT_MAX_MESSAGES = 1000;
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
 * Extract messages currently rendered in the DOM.
 * Returns array of { id (int), text, date, from } sorted by id ascending.
 */
async function extractVisibleMessages(page) {
  return page.evaluate(() => {
    const results = [];
    for (const el of document.querySelectorAll('.Message[data-message-id]')) {
      const rawId = el.getAttribute('data-message-id') || '';
      const id = parseInt(rawId, 10);
      if (isNaN(id)) continue;

      const textEl = el.querySelector('.text-content');
      let text = '';
      if (textEl) {
        const clone = textEl.cloneNode(true);
        clone.querySelectorAll('.MessageMeta, .Reactions, .message-reaction').forEach(m => m.remove());
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
  });
}

/**
 * Collect all new messages since lastSeenId.
 *
 * Telegram Web A uses virtual scrolling — only ~40 messages are in the DOM
 * at once. The chat opens at the last-read position (near lastSeenId).
 * Scrolling does NOT load messages beyond what Telegram has in memory.
 *
 * Strategy:
 * 1. Collect visible messages at opening position
 * 2. Click "Go to bottom" FAB to trigger focusLastMessage() → server fetch
 *    (uses Playwright real clicks + dispatchEvent fallback)
 * 3. Scroll UP from the bottom to fill the gap back to lastSeenId
 * 4. Filter, sort, return
 */
async function collectMessages(page, groupUrl, lastSeenId, maxMessages) {
  const lastId = lastSeenId ? parseInt(lastSeenId, 10) : null;
  const t0 = Date.now();
  const dbg = (msg) => console.error(`[collect +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`);
  const collected = new Map(); // id → { id, text, date, from }
  const MAX_SCROLL_PAGES = 50; // enough for ~2000 messages
  const SCROLL_PAGE_SETTLE_MS = 1500;

  dbg(`Config: maxMessages=${maxMessages}, MAX_SCROLL_PAGES=${MAX_SCROLL_PAGES}`);

  // Log viewport and scroll container info for debugging
  const viewportInfo = await page.evaluate(() => {
    const msgCount = document.querySelectorAll('.Message[data-message-id]').length;
    const scrollEl = document.querySelector('.MessageList') ||
                     document.querySelector('[class*="MessageList"]') ||
                     document.querySelector('.messages-container');
    const scrollInfo = scrollEl ? {
      scrollHeight: scrollEl.scrollHeight,
      clientHeight: scrollEl.clientHeight,
      scrollTop: scrollEl.scrollTop,
    } : null;
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      msgCount,
      scrollInfo,
    };
  });
  dbg(`Viewport: ${viewportInfo.innerWidth}x${viewportInfo.innerHeight}, DOM messages: ${viewportInfo.msgCount}, scroll: ${JSON.stringify(viewportInfo.scrollInfo)}`);

  // --- Phase 1: Collect at opening position ---
  let msgs = await extractVisibleMessages(page);
  for (const m of msgs) collected.set(m.id, m);
  dbg(`Phase 1 — Initial: ${msgs.length} visible, range ${msgs[0]?.id}-${msgs[msgs.length-1]?.id} (lastSeenId=${lastId})`);

  // If nothing visible, wait for SPA sync then try reload
  if (msgs.length === 0) {
    dbg('No messages visible, waiting for sync...');
    for (let i = 0; i < 3; i++) {
      await page.waitForTimeout(3000);
      msgs = await extractVisibleMessages(page);
      if (msgs.length > 0) break;
    }
    if (msgs.length === 0) {
      dbg('Still no messages after sync, reloading page...');
      await page.goto(groupUrl, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });
      await page.waitForTimeout(8000);
      await page.waitForSelector('.Message[data-message-id]', {
        timeout: EXTRACT_TIMEOUT_MS,
      }).catch(() => {});
      msgs = await extractVisibleMessages(page);
    }
    for (const m of msgs) collected.set(m.id, m);
    dbg(`After recovery: ${msgs.length} visible`);
  }

  // --- Phase 2: Jump to bottom via FAB, then scroll to collect ---
  // Telegram Web A only keeps ~40 messages in memory around the "focus point".
  // Scrolling past that boundary does NOT load new messages from the server.
  // We MUST click the "Go to bottom" FAB to trigger focusLastMessage() → API fetch.
  // Use Playwright's real click (not DOM .click()) to trigger React handlers.
  dbg(`Phase 2 — Jump to bottom via FAB (collected so far: ${collected.size})`);

  const prevMaxBeforeFab = await getMaxVisibleId(page) || 0;
  let fabWorked = false;

  // Click FAB using the exact locator pattern proven to work in debug-scroll.js:
  // page.locator('button').filter({ has: page.locator('i[class*="arrow-down"]') })
  const fabBtn = page.locator('button').filter({
    has: page.locator('i[class*="arrow-down"]'),
  }).first();

  for (let fabAttempt = 0; fabAttempt < 5; fabAttempt++) {
    if (await fabBtn.count() === 0) {
      dbg(`  FAB click ${fabAttempt + 1}: no FAB found (already at bottom?)`);
      fabWorked = true;
      break;
    }
    try {
      await fabBtn.click({ force: true, timeout: 3000 });
      dbg(`  FAB click ${fabAttempt + 1}: clicked`);
    } catch (e) {
      dbg(`  FAB click ${fabAttempt + 1}: failed: ${e.message}`);
    }

    // Wait for Telegram to fetch and render new messages
    await page.waitForTimeout(3000);
    const curMax = await getMaxVisibleId(page) || 0;
    dbg(`  after FAB click: maxId ${prevMaxBeforeFab} → ${curMax}`);

    if (curMax > prevMaxBeforeFab + 5) {
      fabWorked = true;
      dbg(`  FAB worked! Jumped from ${prevMaxBeforeFab} to ${curMax}`);
      break;
    }
  }

  // Now collect what's visible after jumping to bottom
  const bottomMsgs = await extractVisibleMessages(page);
  for (const m of bottomMsgs) collected.set(m.id, m);
  const bottomMax = await getMaxVisibleId(page) || 0;
  dbg(`  after jump: ${bottomMsgs.length} visible, maxId=${bottomMax}, total collected=${collected.size}`);

  // Scroll UP from the bottom all the way back to lastSeenId.
  // The page could have opened at ANY position, so we can't assume Phase 1
  // collected anything near lastSeenId. Scroll until minVisible <= lastSeenId.
  // For first fetch (no lastSeenId), skip — just use what's at the bottom.
  if (lastId !== null) {
    dbg(`Phase 2b — Scrolling up from bottom to lastSeenId=${lastId}`);
    let noProgressCount = 0;

    for (let pg = 0; pg < MAX_SCROLL_PAGES; pg++) {
      const minVisible = await page.evaluate(() => {
        const els = document.querySelectorAll('.Message[data-message-id]');
        let min = null;
        for (const el of els) {
          const id = parseInt(el.getAttribute('data-message-id'), 10);
          if (!isNaN(id) && (min === null || id < min)) min = id;
        }
        return min;
      });

      // Stop when we can see messages at or before lastSeenId
      if (minVisible !== null && minVisible <= lastId) {
        dbg(`  reached lastSeenId zone (minVisible=${minVisible})`);
        const zoneMsgs = await extractVisibleMessages(page);
        for (const m of zoneMsgs) {
          if (!collected.has(m.id)) collected.set(m.id, m);
        }
        break;
      }

      // Scroll the message list container to the top to trigger Telegram's
      // intersection observer that loads older messages from the server.
      // mouse.wheel / PageUp alone can fail when the virtual scroll viewport
      // is small (few messages rendered) — the container is already at scrollTop=0
      // but Telegram hasn't loaded the next chunk yet.
      await page.evaluate(() => {
        // Find the scrollable container — Telegram Web A uses a div with
        // class containing "MessageList" or a bubbles container
        const scrollEl = document.querySelector('.MessageList') ||
                         document.querySelector('[class*="MessageList"]') ||
                         document.querySelector('.messages-container');
        if (scrollEl) {
          scrollEl.scrollTo({ top: 0, behavior: 'smooth' });
        }
        // Also scroll the first message into view to trigger intersection observer
        const firstMsg = document.querySelector('.Message[data-message-id]');
        if (firstMsg) {
          firstMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
      await page.waitForTimeout(500);
      // Follow up with keyboard PageUp for redundancy
      await page.keyboard.press('PageUp');
      await page.waitForTimeout(SCROLL_PAGE_SETTLE_MS);

      const pgMsgs = await extractVisibleMessages(page);
      let added = 0;
      for (const m of pgMsgs) {
        if (!collected.has(m.id)) { collected.set(m.id, m); added++; }
      }

      dbg(`  up ${pg + 1}: minVisible=${minVisible}, added=${added}, total=${collected.size}`);

      if (added === 0) {
        noProgressCount++;
        if (noProgressCount >= 3) {
          dbg('  no progress scrolling up, stopping');
          break;
        }
        // Extra wait on stall — Telegram may be fetching from server
        await page.waitForTimeout(2000);
      } else {
        noProgressCount = 0;
      }

      if (collected.size >= maxMessages) {
        dbg(`  hit maxMessages cap (${maxMessages})`);
        break;
      }
    }
  }

  // --- Phase 3: Filter and sort ---
  let results = Array.from(collected.values())
    .filter(m => lastId === null || m.id > lastId)
    .sort((a, b) => a.id - b.id)
    .slice(0, maxMessages);

  // Detect gaps in the collected message IDs
  if (results.length > 1) {
    const gaps = [];
    for (let i = 1; i < results.length; i++) {
      const diff = results[i].id - results[i - 1].id;
      if (diff > 5) { // Allow small gaps from deleted messages
        gaps.push(`${results[i - 1].id}..${results[i].id} (${diff - 1} missing)`);
      }
    }
    if (gaps.length > 0) {
      dbg(`WARNING: ${gaps.length} gap(s) detected: ${gaps.join(', ')}`);
    }
  }

  results = results.map(m => ({ ...m, id: String(m.id) }));

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  dbg(`Final: ${results.length} messages (${results[0]?.id}-${results[results.length-1]?.id}), collected ${collected.size} total in ${elapsed}s`);
  return results;
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
    // Chromium ignores HTTP_PROXY/HTTPS_PROXY env vars.
    // Use Playwright's proxy API + --proxy-server flag (belt and suspenders).
    const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
    const chromiumArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ];
    const launchOptions = {
      headless: true,
      args: chromiumArgs,
    };
    if (proxyUrl) {
      chromiumArgs.push(`--proxy-server=${proxyUrl}`);
      launchOptions.proxy = { server: proxyUrl };
      console.error(`[proxy] Using proxy: ${proxyUrl}`);
    }

    context = await chromium.launchPersistentContext(PROFILE_DIR, launchOptions);

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

    // Wait for the message list to appear
    try {
      await page.waitForSelector('.Message[data-message-id]', {
        timeout: EXTRACT_TIMEOUT_MS,
      });
    } catch {
      const bodyText = await page.textContent('body').catch(() => '');
      if (bodyText && (bodyText.includes('no messages') || bodyText.includes('empty'))) {
        outputResult([], null);
        return;
      }
      outputError(
        'FETCH_FAILED',
        `Could not find message elements on page. URL: ${page.url()}`
      );
      return;
    }

    // Collect all messages from lastSeenId to the newest.
    // Handles virtual scrolling by scrolling through the chat with PageDown/PageUp.
    const messages = await collectMessages(page, groupUrl, lastSeenId, maxMessages);

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
