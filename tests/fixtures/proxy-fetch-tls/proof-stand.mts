// The proof stand: builds the recording proxy (CONNECT + absolute-form,
// vault-shaped), the https target server and the 307-forge http server, then
// spawns the actual proof runner WITH the loader-shaped proxy environment in
// place from the start (Node's built-in proxy support reads the environment
// when it initializes, so the values must be there before the first fetch).
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const LAN = process.env['LAN'] ?? '';
const certDir = process.env['PROOF_CERT_DIR'];
if (certDir === undefined) {
  console.error('PROOF STAND: no PROOF_CERT_DIR');
  process.exit(1);
}
const key = fs.readFileSync(`${certDir}/server.key`);
const cert = fs.readFileSync(`${certDir}/server.pem`);
const caPem = fs.readFileSync(`${certDir}/ca.pem`);

const tlsRequests = [];
const tlsServer = https.createServer({ key, cert }, (req, res) => {
  tlsRequests.push({ method: req.method, url: req.url });
  if (req.url?.endsWith('/getMe')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'q4xtf2', username: 'q4xtf2_bot' },
      })
    );
    return;
  }
  if (req.url?.endsWith('/v1/chat/completions')) {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          model: JSON.parse(Buffer.concat(chunks).toString('utf8')).model,
        })
      );
    });
    return;
  }
  if (req.url?.endsWith('/hang-headers')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('started\n'); // body never ends
    return;
  }
  // never respond
});
await new Promise((resolve) => tlsServer.listen(0, '0.0.0.0', resolve));
const tlsPort = tlsServer.address().port;

const absoluteForm = [];
const proxy = http.createServer((req, res) => {
  absoluteForm.push({ method: req.method, url: req.url });
  let target: URL;
  try {
    target = new URL(req.url);
  } catch {
    res.writeHead(400);
    res.end('forward proxy serves absolute-form requests only');
    return;
  }
  if (target.protocol !== 'http:') {
    // Agent Vault's shape: the forward path serves only http://.
    res.writeHead(400);
    res.end('forward proxy refuses a non-http absolute-form target');
    return;
  }
  const relayed = { ...req.headers };
  delete relayed['proxy-authorization'];
  delete relayed['proxy-connection'];
  delete relayed['connection'];
  const upstream = http.request(req.url, { method: req.method, headers: relayed }, (ur) => {
    res.writeHead(ur.statusCode ?? 502, ur.headers);
    ur.pipe(res);
  });
  upstream.on('error', (error) => {
    res.writeHead(502);
    res.end(`relay failed: ${error.message}`);
  });
  req.pipe(upstream);
});
const connects = [];
proxy.on('connect', (req, socket) => {
  connects.push(req.url);
  socket.write('HTTP/1.1 200 Connection established\r\n\r\n');
  const target = new URL(`placeholder://${req.url}`);
  const tunnel = net.connect(
    Number(target.port === '' ? 443 : target.port),
    target.hostname,
    () => {
      socket.pipe(tunnel);
      tunnel.pipe(socket);
    }
  );
  tunnel.on('error', () => socket.destroy());
  socket.on('error', () => tunnel.destroy());
});
await new Promise((resolve) => proxy.listen(0, '0.0.0.0', resolve));
const proxyPort = proxy.address().port;

const forwardHop = http.createServer((req, res) => {
  if (req.url?.endsWith('/v1/chat/completions')) {
    res.writeHead(307, { location: `https://${LAN}:${tlsPort}/v1/chat/completions` });
    res.end();
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise((resolve) => forwardHop.listen(0, '0.0.0.0', resolve));
const forwardPort = forwardHop.address().port;

// The forward hop lives on a loopback-adjacent address; its absolute-form
// request must travel through the proxy. The HTTPS target uses a distinct
// loopback address, supplied through the LAN environment variable.
console.error(
  `PROOF STAND PORTS: proxy=${proxyPort} tls=${tlsPort} forward=${forwardPort} lan=${LAN}`
);
const runner = path.join(here, 'proof-runner.mts');
const child = spawn(process.execPath, ['--import', 'tsx', runner], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PROXY_PORT: String(proxyPort),
    TLS_PORT: String(tlsPort),
    FORWARD_PORT: String(forwardPort),
    LAN: LAN,
    HTTP_PROXY: `http://q4xtf2-agent:lifemodel@${LAN}:${proxyPort}`,
    HTTPS_PROXY: `http://q4xtf2-agent:lifemodel@${LAN}:${proxyPort}`,
    http_proxy: `http://q4xtf2-agent:lifemodel@${LAN}:${proxyPort}`,
    https_proxy: `http://q4xtf2-agent:lifemodel@${LAN}:${proxyPort}`,
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: process.env['NODE_EXTRA_CA_CERTS'] ?? `${certDir}/ca.pem`,
    PROOF_CERT_DIR: certDir,
    NO_PROXY: '',
    no_proxy: '',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('exit', (code, signal) => {
  tlsServer.closeAllConnections?.();
  tlsServer.close();
  proxy.close();
  forwardHop.close();
  console.error(`PROOF STAND: runner exited with code ${String(code)} signal ${String(signal)}`);
  console.error(
    `PROOF STAND RECORD: connects ${connects.length} absolute-form ${absoluteForm.length}`
  );
  for (const c of connects) console.error(`PROOF STAND CONNECT: ${c}`);
  for (const a of absoluteForm) console.error(`PROOF STAND ABS: ${a.method} ${a.url}`);
  process.exit(code === null ? 1 : code);
});
