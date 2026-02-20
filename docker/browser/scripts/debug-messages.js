/**
 * Debug Helper: Dump message extraction from a Telegram group/channel
 *
 * Navigates to a group URL and reports which message selectors match,
 * sample message HTML structure, and extracted content using both
 * the production extraction logic and raw DOM inspection.
 *
 * Usage (from project root):
 *   docker run -d --name tg-debug \
 *     -v lifemodel-browser-profile-<PROFILE>:/profile \
 *     --network bridge \
 *     --entrypoint sleep lifemodel-browser:latest 3600
 *
 *   docker cp docker/browser/scripts/debug-messages.js tg-debug:/tmp/debug-messages.js
 *   docker exec -e NODE_PATH=/scripts/node_modules \
 *     -e GROUP_URL='https://web.telegram.org/a/#-100XXXXXXXXXX' \
 *     tg-debug node /tmp/debug-messages.js
 *
 *   docker stop tg-debug && docker rm tg-debug
 *
 * Environment:
 *   GROUP_URL — full Telegram Web A URL with fragment (required)
 *   WAIT_MS   — SPA sync wait in ms (default: 10000)
 *   MAX_MSGS  — max messages to extract (default: 5)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE_DIR = '/profile';
const GROUP_URL = process.env.GROUP_URL;
const WAIT_MS = parseInt(process.env.WAIT_MS || '10000', 10);
const MAX_MSGS = parseInt(process.env.MAX_MSGS || '5', 10);

if (!GROUP_URL) {
  console.error('[debug-messages] Error: GROUP_URL env var is required');
  console.error('[debug-messages] Example: GROUP_URL="https://web.telegram.org/a/#-100XXXXXXXXXX"');
  process.exit(1);
}

function cleanStaleLocks() {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, name)); } catch { /* ok */ }
  }
}

async function main() {
  cleanStaleLocks();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = context.pages()[0] || await context.newPage();
  console.error(`[debug-messages] Navigating to: ${GROUP_URL}`);
  await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  console.error(`[debug-messages] Waiting ${WAIT_MS}ms for messages to load...`);
  await page.waitForTimeout(WAIT_MS);
  console.error(`[debug-messages] URL: ${page.url()}`);

  const info = await page.evaluate((maxMsgs) => {
    // Selector match counts
    const selectors = {
      '.Message': document.querySelectorAll('.Message').length,
      '.Message[data-message-id]': document.querySelectorAll('.Message[data-message-id]').length,
      '[data-message-id]': document.querySelectorAll('[data-message-id]').length,
      '.message-list-item': document.querySelectorAll('.message-list-item').length,
      '.MessageList': document.querySelectorAll('.MessageList').length,
      '.text-content': document.querySelectorAll('.text-content').length,
      '.sender-title': document.querySelectorAll('.sender-title').length,
      '.message-time': document.querySelectorAll('.message-time').length,
      '.MessageMeta': document.querySelectorAll('.MessageMeta').length,
      // Legacy selectors (Web K) — should be 0 on Web A
      '.message[data-mid]': document.querySelectorAll('.message[data-mid]').length,
      '.bubble[data-mid]': document.querySelectorAll('.bubble[data-mid]').length,
    };

    // Extract messages using production logic
    const messages = [];
    const messageElements = document.querySelectorAll('.Message[data-message-id]');
    const elements = Array.from(messageElements).slice(-maxMsgs);

    for (const el of elements) {
      const id = el.getAttribute('data-message-id') || '';
      if (!id) continue;

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

      messages.push({ id, text: text.slice(0, 300), date, from });
    }

    // Sample one raw Message element for HTML inspection
    const sampleEl = document.querySelector('.Message[data-message-id]');
    const sampleHTML = sampleEl ? sampleEl.outerHTML.slice(0, 1500) : null;

    return { selectors, messages, sampleHTML };
  }, MAX_MSGS);

  process.stdout.write(JSON.stringify(info, null, 2));
  console.error(`[debug-messages] Done. Extracted ${info.messages.length} messages.`);
  await context.close();
}

main().catch((err) => {
  console.error(`[debug-messages] Fatal: ${err.message}`);
  process.exit(1);
});
