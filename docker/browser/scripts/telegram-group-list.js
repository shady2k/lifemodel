/**
 * Telegram Group Discovery
 *
 * Playwright script that reads SCRIPT_INPUTS env, launches a persistent
 * browser context (headless) with a pre-authenticated profile, navigates
 * to Telegram Web A, and extracts all groups/channels from the sidebar.
 *
 * Input:  { profile }
 * Output: { ok, groups: [{id, name, url}] }
 *
 * Error codes:
 * - NOT_AUTHENTICATED: redirect to login page detected
 * - FETCH_FAILED: navigation or extraction error
 */

const { chromium } = require('playwright');
const { waitForReady } = require('./wait-ready');
const fs = require('fs');
const path = require('path');

const NAV_TIMEOUT_MS = 30_000;
const SIDEBAR_TIMEOUT_MS = 30_000;
const PROFILE_DIR = '/profile';

/**
 * Remove stale Chromium lock files from a persistent profile.
 * When a container is killed (not gracefully stopped), Chromium leaves
 * SingletonLock/SingletonSocket/SingletonCookie pointing to the dead
 * container's hostname. New Chromium instances refuse to use the profile
 * or launch in a degraded state (CacheStorage fails silently).
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

  // profile is validated by the registry schema — just needs to exist for context launch
  void inputs.profile;

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

    // Navigate to Telegram Web A sidebar
    await page.goto('https://web.telegram.org/a/', {
      waitUntil: 'load',
      timeout: NAV_TIMEOUT_MS,
    });

    // Wait for SPA to render and sync (Telegram Web A needs time after 'load'
    // to establish MTProto WebSocket and populate the chat list from server)
    await page.waitForTimeout(10000);

    // Detect auth failure: URL-based check + UI element check
    // Telegram Web A shows QR login at the root URL without redirect
    const currentUrl = page.url();
    const urlIndicatesLogin =
      currentUrl.includes('/auth') ||
      currentUrl.includes('login') ||
      currentUrl.includes('#/login');

    const hasLoginUI = await page.evaluate(() => {
      const text = document.querySelector('#root')?.textContent ?? '';
      return (
        text.includes('Log in to Telegram') ||
        text.includes('QR Code') ||
        text.includes('Log in by phone') ||
        text.includes('Войти в Telegram') ||
        text.includes('QR-код') ||
        text.includes('Вход по номеру') ||
        // Generic: look for QR code canvas (always present on login, regardless of locale)
        !!document.querySelector('canvas.qr-canvas, .auth-form canvas')
      );
    });

    if (urlIndicatesLogin || hasLoginUI) {
      outputError(
        'NOT_AUTHENTICATED',
        'Not authenticated. Call auth_profile to log in first.'
      );
      return;
    }

    // Wait for the chat list sidebar to populate
    // Telegram Web A renders chat items as .ListItem.Chat inside a .chat-list container.
    // Note: data-peer-id exists on Avatar sub-elements, NOT on the .Chat wrapper itself.
    try {
      await page.waitForSelector('.chat-list .Chat', {
        timeout: SIDEBAR_TIMEOUT_MS,
      });
    } catch {
      // Check if we're authenticated but have no chats
      const bodyText = await page.evaluate(() => {
        const root = document.querySelector('#root');
        if (!root) return '';
        const clone = root.cloneNode(true);
        clone.querySelectorAll('noscript').forEach(n => n.remove());
        return clone.textContent.trim();
      });
      if (bodyText && bodyText.includes('Start messaging')) {
        outputResult([]);
        return;
      }
      // Re-check for login UI (session may have expired during load)
      if (bodyText && (bodyText.includes('Log in') || bodyText.includes('QR Code') || bodyText.includes('Войти') || bodyText.includes('QR-код'))) {
        outputError(
          'NOT_AUTHENTICATED',
          'Not authenticated. Call auth_profile to log in first.'
        );
        return;
      }
      outputError(
        'FETCH_FAILED',
        `Could not find chat list elements on page. URL: ${page.url()}. Body text (first 300 chars): ${(bodyText || '').slice(0, 300)}`
      );
      return;
    }

    // Give the chat list a moment to fully render (groups load asynchronously)
    await page.waitForTimeout(2000);

    // Extract groups and channels from the sidebar.
    // Telegram Web A applies CSS classes to distinguish chat types:
    //   .Chat.group — group chats and channels
    //   .Chat.forum — forum-style supergroups
    //   .Chat.private — direct messages
    // The peer ID is embedded in the <a> href (e.g., href="#-100XXXXXXXXXX").
    const groups = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      const items = document.querySelectorAll(
        '.chat-list .Chat.group, .chat-list .Chat.forum'
      );

      for (const el of items) {
        // Extract peer ID from the link href
        const link = el.querySelector('a.ListItem-button');
        const href = link ? link.getAttribute('href') : null;
        const peerId = href ? href.replace('#', '') : null;
        if (!peerId || seen.has(peerId)) continue;
        seen.add(peerId);

        // Extract the group/channel name
        const titleEl = el.querySelector('.fullName, h3');
        const name = titleEl ? titleEl.textContent.trim() : '';
        if (!name) continue;

        const url = `https://web.telegram.org/a/#${peerId}`;

        results.push({
          id: peerId,
          name,
          url,
        });
      }

      return results;
    });

    outputResult(groups);
  } catch (err) {
    outputError('FETCH_FAILED', err.message || String(err));
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

function outputResult(groups) {
  const result = {
    ok: true,
    groups,
  };
  process.stdout.write(JSON.stringify(result));
}

function outputError(code, message) {
  const result = {
    ok: false,
    error: { code, message },
    groups: [],
  };
  process.stdout.write(JSON.stringify(result));
}

main().catch((err) => {
  outputError('FETCH_FAILED', `Unhandled: ${err.message || String(err)}`);
  process.exit(1);
});
