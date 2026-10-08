// A stand-in for the loader (lifemodel-q4x.2.1) — see README.md next to it.
// It follows the contract of the image's Dockerfile and Caddyfile, so the
// image can be built and checked before the real loader exists.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';

const SESSION = 'lm_session=stub-session';

// The loader owns the others in the trusted layer, so it is the loader that
// starts Caddy: the pinned binary and the configuration the image fixes
// (/usr/bin/caddy, /etc/lifemodel/Caddyfile). Its stdout is this process's, so
// the front door's access log lands in the container log.
const CADDY = '/usr/bin/caddy';
const CADDYFILE = '/etc/lifemodel/Caddyfile';

function log(fields) {
  // One line per event, the way the contract asks the loader to write them.
  process.stdout.write(
    `component=loader ${Object.entries(fields)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}
`,
  );
}

function cookies(req) {
  return req.headers.cookie ?? '';
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

// The loader's own interface: 127.0.0.1:7000.
const loader = createServer((req, res) => {
  const path = new URL(req.url, 'http://load').pathname;
  const authed = cookies(req).includes(SESSION);
  let status = 200;
  let body = 'stub-loader';

  if (path === '/_auth/verify') {
    // Caddy's forward_auth: 2xx with the session cookie, 401 without it.
    status = authed ? 204 : 401;
    body = authed ? '' : '{"error":"unauthorized"}';
    send(res, status, body, { 'Content-Type': 'application/json' });
    log({ event: 'auth', path, host: req.headers.host ?? '', status });
    return;
  }
  if (path === '/login' || path.startsWith('/login/')) {
    body = 'stub-loader-login';
  } else if (path === '/setup' || path.startsWith('/setup/')) {
    body = 'stub-loader-setup';
  } else if (!authed) {
    // No other page of the loader is public.
    status = 401;
    body = '{"error":"unauthorized"}';
    send(res, status, body, { 'Content-Type': 'application/json' });
    log({ event: 'request', path, host: req.headers.host ?? '', status });
    return;
  }
  send(res, status, body);
  log({ event: 'request', path, host: req.headers.host ?? '', status });
});

// lifemodel's own interface (stage 3), so the root host has something to pass
// through to. Agent Vault's ports (14321, 14322) stay closed: stage 2.
const lifemodel = createServer((req, res) => {
  send(res, 200, 'stub-lifemodel');
  log({ event: 'lifemodel', path: req.url ?? '', host: req.headers.host ?? '' });
});

loader.listen(7000, '127.0.0.1', () => log({ event: 'listening', port: 7000 }));
lifemodel.listen(7100, '127.0.0.1', () => log({ event: 'listening', port: 7100 }));

const caddy = spawn(CADDY, ['run', '--config', CADDYFILE, '--adapter', 'caddyfile'], {
  stdio: ['ignore', 'inherit', 'inherit'],
});
caddy.on('exit', (code) => log({ event: 'caddy-exit', code: String(code) }));

/** The front door answers on :80 when its socket accepts a connection. */
function frontDoorIsUp() {
  return new Promise((resolve) => {
    const socket = connect(80, '127.0.0.1');
    socket.once('connect', () => {
      socket.end();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

const caddyDeadline = Date.now() + 30_000;
while (!(await frontDoorIsUp())) {
  if (Date.now() > caddyDeadline) {
    log({ event: 'caddy-failed', reason: 'no answer from 127.0.0.1:80' });
    process.exit(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
}
log({ event: 'caddy-listening', port: 80 });

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log({ event: 'signal', signal });
    caddy.kill('SIGTERM');
    process.exit(0);
  });
}
