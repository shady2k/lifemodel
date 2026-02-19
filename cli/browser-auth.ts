#!/usr/bin/env npx tsx
/**
 * Browser Authentication CLI
 *
 * Creates or reuses a Docker volume for browser profile persistence,
 * builds the browser image if needed, and starts a container with
 * noVNC for interactive authentication.
 *
 * Usage: npx tsx cli/browser-auth.ts <profile> <url>
 *
 * Example:
 *   npx tsx cli/browser-auth.ts telegram https://web.telegram.org
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { ensureBrowserImage } from '../src/runtime/container/browser-image.js';
import { BROWSER_IMAGE } from '../src/runtime/container/types.js';

const execFileAsync = promisify(execFile);

const VOLUME_PREFIX = 'lifemodel-browser-profile';

function usage(): never {
  console.error('Usage: npx tsx cli/browser-auth.ts <profile> <url>');
  console.error('');
  console.error('Arguments:');
  console.error('  profile  Profile name (alphanumeric + hyphens, e.g. "telegram")');
  console.error('  url      URL to navigate to (e.g. "https://web.telegram.org")');
  console.error('');
  console.error('Example:');
  console.error('  npm run browser:auth telegram https://web.telegram.org');
  process.exit(1);
}

function validateProfile(profile: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(profile);
}

function validateUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

async function waitForEnter(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question('\nPress Enter to stop the container and save the profile...', () => {
      rl.close();
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    usage();
  }

  const [profile, url] = args as [string, string];

  if (!validateProfile(profile)) {
    console.error(`Error: Invalid profile name "${profile}". Use alphanumeric characters and hyphens.`);
    process.exit(1);
  }

  if (!validateUrl(url)) {
    console.error(`Error: Invalid URL "${url}".`);
    process.exit(1);
  }

  const volumeName = `${VOLUME_PREFIX}-${profile}`;

  // 1. Ensure browser image exists
  console.log('Ensuring browser image is built...');
  const built = await ensureBrowserImage((msg) => {
    console.log(`  ${msg}`);
  });
  if (!built) {
    console.error('Error: Failed to build browser image.');
    process.exit(1);
  }

  // 2. Create or reuse profile volume
  console.log(`Creating/reusing profile volume: ${volumeName}`);
  try {
    await execFileAsync('docker', ['volume', 'create', volumeName], { timeout: 10_000 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error creating volume: ${msg}`);
    process.exit(1);
  }

  // 3. Start container with noVNC
  console.log('Starting browser container...');
  let containerId: string;
  try {
    const { stdout } = await execFileAsync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '-v', `${volumeName}:/profile:rw`,
        '-p', '127.0.0.1:6080:6080',
        '-e', `AUTH_URL=${url}`,
        '--tmpfs', '/tmp:rw,noexec,nosuid,size=256m',
        '--entrypoint', '/scripts/entrypoint-auth.sh',
        BROWSER_IMAGE,
      ],
      { timeout: 30_000 }
    );
    containerId = stdout.trim();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error starting container: ${msg}`);
    process.exit(1);
  }

  console.log('');
  console.log('========================================');
  console.log('  Browser is ready for authentication!');
  console.log('  Open: http://localhost:6080/vnc.html');
  console.log('========================================');
  console.log('');
  console.log(`Profile: ${profile} (volume: ${volumeName})`);
  console.log(`URL: ${url}`);

  // 4. Wait for user to finish
  await waitForEnter();

  // 5. Stop container (--rm flag auto-removes it)
  console.log('Stopping container...');
  try {
    await execFileAsync('docker', ['stop', containerId], { timeout: 30_000 });
    console.log('Container stopped. Profile saved.');
  } catch {
    // Container may already be stopped
    console.log('Container already stopped.');
  }

  console.log(`\nProfile "${profile}" is ready. Use it in news sources with type "telegram-group".`);
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
