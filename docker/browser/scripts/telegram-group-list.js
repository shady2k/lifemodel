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

    // Wait for SPA to render and sync (Telegram Web A needs time to load chat list)
    await page.waitForTimeout(5000);

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
    // Telegram Web A renders chat list items with ListItem class and data-peer-id
    try {
      await page.waitForSelector('[data-peer-id]', {
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

    // Extract groups and channels from the sidebar
    // In Telegram Web A, groups/channels have negative peer IDs
    const groups = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // Find all chat list items with peer IDs
      const items = document.querySelectorAll(
        '[data-peer-id], [class*="ListItem"][data-peer-id], .chat-list .ListItem'
      );

      for (const el of items) {
        const peerId = el.getAttribute('data-peer-id');
        if (!peerId) continue;

        // Only include groups/channels (negative peer IDs)
        // Private chats have positive IDs
        const numericId = parseInt(peerId, 10);
        if (numericId >= 0) continue;

        // Deduplicate
        if (seen.has(peerId)) continue;
        seen.add(peerId);

        // Extract the group/channel name from the title element
        const titleEl = el.querySelector(
          '[class*="title"] .fullName, [class*="info"] h3, [class*="ChatInfo"] .title, .peer-title, h3'
        );
        const name = titleEl ? titleEl.textContent.trim() : '';
        if (!name) continue;

        // Construct the URL using the peer ID
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
