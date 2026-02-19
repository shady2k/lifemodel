/**
 * Browser Launcher for Authentication
 *
 * Launches Chromium via Playwright's persistent context with a
 * user-data-dir mounted at /profile. Navigates to AUTH_URL and
 * keeps the browser open for the user to complete login.
 *
 * Runs headful via DISPLAY=:99 (Xvfb), visible through noVNC.
 */

const { chromium } = require('playwright');

async function main() {
  const authUrl = process.env.AUTH_URL;
  if (!authUrl) {
    console.error('ERROR: AUTH_URL environment variable is required');
    process.exit(1);
  }

  console.log(`Launching browser with profile at /profile...`);
  console.log(`Navigating to: ${authUrl}`);

  const context = await chromium.launchPersistentContext('/profile', {
    headless: false,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
    ],
    viewport: { width: 1280, height: 720 },
    ignoreDefaultArgs: ['--enable-automation'],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(authUrl, { waitUntil: 'domcontentloaded' });

  console.log('Browser ready. Complete authentication in the noVNC window.');

  // Keep alive — container is stopped externally
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('Browser launch failed:', err.message);
  process.exit(1);
});
