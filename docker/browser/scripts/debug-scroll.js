/**
 * Debug Helper: Test scroll-to-latest approach for Telegram Web A
 *
 * Navigates to a group URL, reports the initial message state, then
 * tests the "scroll up → click FAB → check for new messages" strategy.
 *
 * Usage (from project root):
 *   docker run -d --name tg-debug \
 *     -v lifemodel-browser-profile-<PROFILE>:/profile \
 *     --network bridge \
 *     --entrypoint sleep lifemodel-browser:latest 3600
 *
 *   docker cp docker/browser/scripts/debug-scroll.js tg-debug:/tmp/debug-scroll.js
 *   docker exec -e NODE_PATH=/scripts/node_modules \
 *     -e GROUP_URL='https://web.telegram.org/a/#-100XXXXXXXXXX' \
 *     tg-debug node /tmp/debug-scroll.js
 *
 *   docker stop tg-debug && docker rm tg-debug
 *
 * Environment:
 *   GROUP_URL — full Telegram Web A URL with fragment (required)
 *   WAIT_MS   — SPA sync wait in ms (default: 10000)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE_DIR = '/profile';
const GROUP_URL = process.env.GROUP_URL;
const WAIT_MS = parseInt(process.env.WAIT_MS || '10000', 10);

if (!GROUP_URL) {
  console.error('[debug-scroll] Error: GROUP_URL env var is required');
  process.exit(1);
}

function cleanStaleLocks() {
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { fs.unlinkSync(path.join(PROFILE_DIR, name)); } catch { /* ok */ }
  }
}

function log(msg) {
  console.error(`[debug-scroll] ${msg}`);
}

async function getMessageIdRange(page) {
  return page.evaluate(() => {
    const els = document.querySelectorAll('.Message[data-message-id]');
    let min = null, max = null;
    for (const el of els) {
      const id = parseInt(el.getAttribute('data-message-id'), 10);
      if (isNaN(id)) continue;
      if (min === null || id < min) min = id;
      if (max === null || id > max) max = id;
    }
    return { count: els.length, min, max };
  });
}

async function findScrollContainer(page) {
  return page.evaluate(() => {
    const msg = document.querySelector('.Message[data-message-id]');
    if (!msg) return null;

    let el = msg.parentElement;
    while (el && el !== document.documentElement) {
      const style = window.getComputedStyle(el);
      const overflowY = style.overflowY;
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 1
      ) {
        return {
          found: true,
          tag: el.tagName,
          classes: el.className.substring(0, 150),
          scrollTop: el.scrollTop,
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY,
        };
      }
      el = el.parentElement;
    }
    return { found: false };
  });
}

async function main() {
  cleanStaleLocks();

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const page = context.pages()[0] || await context.newPage();
  log(`Navigating to: ${GROUP_URL}`);
  await page.goto(GROUP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log(`Waiting ${WAIT_MS}ms for SPA sync...`);
  await page.waitForTimeout(WAIT_MS);
  log(`URL: ${page.url()}`);

  const results = {};

  // Step 1: Initial state
  results.initialMessages = await getMessageIdRange(page);
  results.initialContainer = await findScrollContainer(page);
  log(`Initial state: ${JSON.stringify(results.initialMessages)}`);
  log(`Scroll container: ${JSON.stringify(results.initialContainer)}`);

  // Step 2: Check for FAB button BEFORE scrolling up
  results.fabBeforeScroll = await page.evaluate(() => {
    // Look for arrow-down icon (Telegram Web A's scroll-down button)
    const arrowDown = document.querySelector('i[class*="arrow-down"]');
    const allButtons = document.querySelectorAll('button');
    const buttonInfo = Array.from(allButtons).map(b => ({
      classes: b.className.substring(0, 80),
      ariaLabel: b.getAttribute('aria-label') || '',
      visible: b.offsetParent !== null,
      innerHTML: b.innerHTML.substring(0, 100),
    })).filter(b => b.ariaLabel || b.innerHTML.includes('arrow') || b.innerHTML.includes('down'));

    // Check FloatingActionButtons container
    const fab = document.querySelector('[class*="FloatingActionButtons"]');

    return {
      arrowDownIcon: arrowDown ? { classes: arrowDown.className, parentClasses: arrowDown.parentElement?.className?.substring(0, 100) } : null,
      relevantButtons: buttonInfo,
      fabContainer: fab ? { classes: fab.className.substring(0, 150), visible: fab.offsetParent !== null } : null,
    };
  });
  log(`FAB before scroll: ${JSON.stringify(results.fabBeforeScroll)}`);

  // Step 3: Scroll UP to trigger the FAB to appear
  log('Scrolling UP to trigger FAB appearance...');
  if (results.initialContainer?.found) {
    await page.evaluate(() => {
      const msg = document.querySelector('.Message[data-message-id]');
      if (!msg) return;
      let el = msg.parentElement;
      while (el && el !== document.documentElement) {
        const style = window.getComputedStyle(el);
        if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) {
          el.scrollTop = 0;
          break;
        }
        el = el.parentElement;
      }
    });
  }
  // Also try native wheel up
  await page.mouse.wheel(0, -5000);
  await page.waitForTimeout(2000);

  // Step 4: Check for FAB AFTER scrolling up
  results.fabAfterScrollUp = await page.evaluate(() => {
    const arrowDown = document.querySelector('i[class*="arrow-down"]');
    const fab = document.querySelector('[class*="FloatingActionButtons"]');
    // Also look for any button with arrow-down icon
    const allButtons = document.querySelectorAll('button');
    const downButtons = Array.from(allButtons).filter(b => {
      const icon = b.querySelector('i[class*="arrow-down"]');
      return icon !== null;
    }).map(b => ({
      classes: b.className.substring(0, 100),
      ariaLabel: b.getAttribute('aria-label') || '',
      visible: b.offsetParent !== null,
      rect: b.getBoundingClientRect(),
    }));

    return {
      arrowDownIcon: arrowDown ? {
        classes: arrowDown.className,
        parentTag: arrowDown.parentElement?.tagName,
        parentClasses: arrowDown.parentElement?.className?.substring(0, 100),
        grandparentClasses: arrowDown.parentElement?.parentElement?.className?.substring(0, 100),
        visible: arrowDown.offsetParent !== null,
      } : null,
      fabContainer: fab ? {
        classes: fab.className.substring(0, 150),
        visible: fab.offsetParent !== null,
        childCount: fab.children.length,
        innerHTML: fab.innerHTML.substring(0, 300),
      } : null,
      downButtons,
    };
  });
  log(`FAB after scroll up: ${JSON.stringify(results.fabAfterScrollUp)}`);

  // Step 5: Try to click the scroll-down button
  let clicked = false;
  if (results.fabAfterScrollUp.downButtons?.length > 0) {
    log('Found arrow-down button, clicking...');
    const btn = page.locator('button').filter({ has: page.locator('i[class*="arrow-down"]') }).first();
    try {
      await btn.click({ timeout: 3000 });
      clicked = true;
      log('Clicked scroll-down button!');
    } catch (e) {
      log(`Click failed: ${e.message}`);
    }
  } else if (results.fabAfterScrollUp.arrowDownIcon) {
    log('Found arrow-down icon, clicking parent...');
    try {
      const icon = page.locator('i[class*="arrow-down"]').first();
      await icon.locator('..').click({ timeout: 3000 });
      clicked = true;
      log('Clicked icon parent!');
    } catch (e) {
      log(`Click failed: ${e.message}`);
    }
  } else {
    log('No arrow-down button found, trying aria-label...');
    try {
      const btn = page.locator('button[aria-label*="Page Down"], button[aria-label*="page down"], button[aria-label*="Вниз"]');
      if (await btn.count() > 0) {
        await btn.first().click({ timeout: 3000 });
        clicked = true;
        log('Clicked aria-label button!');
      }
    } catch (e) {
      log(`Aria-label click failed: ${e.message}`);
    }
  }
  results.clickedFAB = clicked;

  // Step 6: Wait for new messages to load
  await page.waitForTimeout(3000);

  // Step 7: Check final state
  results.finalMessages = await getMessageIdRange(page);
  results.finalContainer = await findScrollContainer(page);
  log(`Final state: ${JSON.stringify(results.finalMessages)}`);

  results.newMessagesLoaded =
    results.initialMessages.max !== null &&
    results.finalMessages.max !== null &&
    results.finalMessages.max > results.initialMessages.max;

  log(`New messages loaded: ${results.newMessagesLoaded} (${results.initialMessages.max} → ${results.finalMessages.max})`);

  process.stdout.write(JSON.stringify(results, null, 2));
  log('Done.');
  await context.close();
}

main().catch((err) => {
  console.error(`[debug-scroll] Fatal: ${err.message}`);
  process.exit(1);
});
