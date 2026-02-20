/**
 * Debug Helper: Generic page DOM inspector
 *
 * Navigates to any URL with a persistent browser profile and dumps:
 * - Selector match counts for user-provided selectors
 * - Page text content (first N chars)
 * - Sample elements matching a given selector
 * - Network/auth indicators
 *
 * Use this to debug any browser-based script, not just Telegram.
 *
 * Usage (from project root):
 *   docker run -d --name browser-debug \
 *     -v lifemodel-browser-profile-<PROFILE>:/profile \
 *     --network bridge \
 *     --entrypoint sleep lifemodel-browser:latest 3600
 *
 *   docker cp docker/browser/scripts/debug-page.js browser-debug:/tmp/debug-page.js
 *   docker exec -e NODE_PATH=/scripts/node_modules \
 *     -e TARGET_URL='https://example.com' \
 *     -e SELECTORS='.main,.sidebar,[data-id]' \
 *     browser-debug node /tmp/debug-page.js
 *
 *   docker stop browser-debug && docker rm browser-debug
 *
 * Environment:
 *   TARGET_URL  — URL to navigate to (required)
 *   SELECTORS   — comma-separated CSS selectors to probe (optional)
 *   SAMPLE_SEL  — selector to dump sample outerHTML for (optional, defaults to first in SELECTORS)
 *   SAMPLE_MAX  — max sample elements to dump (default: 3)
 *   WAIT_MS     — wait after page load in ms (default: 8000)
 *   TEXT_LIMIT   — max chars of root text to capture (default: 800)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE_DIR = '/profile';
const TARGET_URL = process.env.TARGET_URL;
const WAIT_MS = parseInt(process.env.WAIT_MS || '8000', 10);
const TEXT_LIMIT = parseInt(process.env.TEXT_LIMIT || '800', 10);
const SAMPLE_MAX = parseInt(process.env.SAMPLE_MAX || '3', 10);

if (!TARGET_URL) {
  console.error('[debug-page] Error: TARGET_URL env var is required');
  process.exit(1);
}

const selectorList = process.env.SELECTORS
  ? process.env.SELECTORS.split(',').map(s => s.trim()).filter(Boolean)
  : [];
const sampleSelector = process.env.SAMPLE_SEL || selectorList[0] || null;

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
  console.error(`[debug-page] Navigating to: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'load', timeout: 30000 });
  console.error(`[debug-page] Waiting ${WAIT_MS}ms...`);
  await page.waitForTimeout(WAIT_MS);
  console.error(`[debug-page] Final URL: ${page.url()}`);

  const info = await page.evaluate(({ selectors, sampleSel, sampleMax, textLimit }) => {
    const root = document.querySelector('#root') || document.body;
    const rootText = root ? root.textContent.trim().slice(0, textLimit) : '(empty)';

    // Probe each selector
    const selectorCounts = {};
    for (const sel of selectors) {
      try {
        selectorCounts[sel] = document.querySelectorAll(sel).length;
      } catch (e) {
        selectorCounts[sel] = `ERROR: ${e.message}`;
      }
    }

    // Sample elements
    const samples = [];
    if (sampleSel) {
      try {
        const els = document.querySelectorAll(sampleSel);
        for (let i = 0; i < Math.min(els.length, sampleMax); i++) {
          const el = els[i];
          samples.push({
            tagName: el.tagName,
            className: (el.className || '').toString().slice(0, 200),
            attributes: Array.from(el.attributes).map(a =>
              `${a.name}=${a.value.slice(0, 80)}`
            ),
            outerHTML: el.outerHTML.slice(0, 500),
          });
        }
      } catch (e) {
        samples.push({ error: e.message });
      }
    }

    return {
      url: location.href,
      title: document.title,
      rootText,
      selectorCounts,
      sampleSelector: sampleSel,
      samples,
    };
  }, { selectors: selectorList, sampleSel: sampleSelector, sampleMax: SAMPLE_MAX, textLimit: TEXT_LIMIT });

  process.stdout.write(JSON.stringify(info, null, 2));
  console.error(`[debug-page] Done.`);
  await context.close();
}

main().catch((err) => {
  console.error(`[debug-page] Fatal: ${err.message}`);
  process.exit(1);
});
