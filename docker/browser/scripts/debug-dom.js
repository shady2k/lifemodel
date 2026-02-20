/**
 * Debug Helper: Dump Telegram Web A DOM state
 *
 * Navigates to Telegram Web A with a persistent profile and reports
 * which selectors match, chat counts by type, and sample element HTML.
 * Use this to diagnose selector breakage when Telegram updates their SPA.
 *
 * Usage (from project root):
 *   docker run -d --name tg-debug \
 *     -v lifemodel-browser-profile-<PROFILE>:/profile \
 *     --network bridge \
 *     --entrypoint sleep lifemodel-browser:latest 3600
 *
 *   docker cp docker/browser/scripts/debug-dom.js tg-debug:/tmp/debug-dom.js
 *   docker exec -e NODE_PATH=/scripts/node_modules tg-debug node /tmp/debug-dom.js
 *
 *   docker stop tg-debug && docker rm tg-debug
 *
 * Environment:
 *   WAIT_MS — SPA sync wait in ms (default: 10000)
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const PROFILE_DIR = '/profile';
const WAIT_MS = parseInt(process.env.WAIT_MS || '10000', 10);

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
  console.error(`[debug-dom] Navigating to Telegram Web A...`);
  await page.goto('https://web.telegram.org/a/', { waitUntil: 'load', timeout: 30000 });
  console.error(`[debug-dom] Waiting ${WAIT_MS}ms for SPA sync...`);
  await page.waitForTimeout(WAIT_MS);
  console.error(`[debug-dom] URL: ${page.url()}`);

  const info = await page.evaluate(() => {
    const root = document.querySelector('#root');
    const rootText = root ? root.textContent.trim().slice(0, 800) : '(no #root)';

    // Selector match counts — update these when investigating breakage
    const selectors = {
      '[data-peer-id]': document.querySelectorAll('[data-peer-id]').length,
      '.chat-list': document.querySelectorAll('.chat-list').length,
      '.chat-list .Chat': document.querySelectorAll('.chat-list .Chat').length,
      '.Chat.group': document.querySelectorAll('.Chat.group').length,
      '.Chat.forum': document.querySelectorAll('.Chat.forum').length,
      '.Chat.private': document.querySelectorAll('.Chat.private').length,
      '.ListItem': document.querySelectorAll('.ListItem').length,
      'a.ListItem-button': document.querySelectorAll('a.ListItem-button').length,
      '.fullName': document.querySelectorAll('.fullName').length,
    };

    // Auth indicators
    const auth = {
      hasLoginText: rootText.includes('Log in to Telegram') || rootText.includes('Войти в Telegram'),
      hasQRCode: rootText.includes('QR Code') || rootText.includes('QR-код'),
      hasQRCanvas: !!document.querySelector('canvas.qr-canvas, .auth-form canvas'),
      hasStartMessaging: rootText.includes('Start messaging'),
    };

    // Sample first 5 group/forum chat items
    const chatSamples = [];
    const chats = document.querySelectorAll('.chat-list .Chat.group, .chat-list .Chat.forum');
    for (let i = 0; i < Math.min(chats.length, 5); i++) {
      const el = chats[i];
      const link = el.querySelector('a.ListItem-button');
      const titleEl = el.querySelector('.fullName, h3');
      chatSamples.push({
        classes: el.className,
        href: link ? link.getAttribute('href') : null,
        title: titleEl ? titleEl.textContent.trim() : '(none)',
        outerHTML: el.outerHTML.slice(0, 400),
      });
    }

    return { rootTextFirst800: rootText, selectors, auth, chatSamples };
  });

  process.stdout.write(JSON.stringify(info, null, 2));
  console.error(`[debug-dom] Done.`);
  await context.close();
}

main().catch((err) => {
  console.error(`[debug-dom] Fatal: ${err.message}`);
  process.exit(1);
});
