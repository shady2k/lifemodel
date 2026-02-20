/**
 * Script readiness gate.
 *
 * When WAIT_FOR_READY=1 is set, blocks until the host writes "ready\n" to stdin.
 * This allows the host to apply network policies (iptables) before the script
 * makes any network requests.
 *
 * Usage in scripts:
 *   const { waitForReady } = require('./wait-ready');
 *   await waitForReady();
 *   // ... safe to use network now
 *
 * If WAIT_FOR_READY is not set, resolves immediately (no-op for no-network scripts).
 */

function waitForReady() {
  if (process.env.WAIT_FOR_READY !== '1') {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('ready')) {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        // Don't hold the event loop — unref stdin so it doesn't prevent exit
        process.stdin.unref();
        resolve();
      }
    });
    process.stdin.on('end', () => {
      // stdin closed without "ready" — proceed anyway to avoid hanging
      resolve();
    });
    process.stdin.resume();
  });
}

module.exports = { waitForReady };
