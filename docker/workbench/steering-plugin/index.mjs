import { createServer } from 'node:net';
import { chmodSync, rmSync } from 'node:fs';

// This bridge does not run an agent or change its model context. It only
// admits input to the native inbox of the ACP session.
export default {
  id: 'lifemodel-steering',
  async setup(ctx) {
    const path = process.env.LIFEMODEL_STEER_SOCKET;
    if (!path) throw new Error('steer_socket_missing');
    const dispositions = new Map();
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: abort.signal })) {
          if (event.type === 'session.inbox.enqueued') dispositions.set(event.data.inboxID, 'pending');
          if (event.type === 'session.inbox.delivered') dispositions.set(event.data.inboxID, 'inserted');
        }
      } catch {
        // Missing events are not evidence of insertion.
      }
    })();
    rmSync(path, { force: true });
    const server = createServer(socket => {
      let buffer = '';
      socket.on('error', () => {});
      socket.on('data', chunk => {
        buffer += chunk.toString();
        if (Buffer.byteLength(buffer) > 1048576) { socket.destroy(); return; }
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        socket.removeAllListeners('data');
        void (async () => {
          try {
            const q = JSON.parse(line);
            let data;
            if (q.op === 'steer' && typeof q.sessionID === 'string' && typeof q.id === 'string' && typeof q.text === 'string') {
              data = await ctx.session.prompt({ sessionID: q.sessionID, id: q.id, text: q.text, delivery: 'steer', resume: false });
            } else if (q.op === 'disposition' && typeof q.id === 'string') {
              data = { id: q.id, status: dispositions.get(q.id) ?? 'unknown' };
            } else {
              socket.end(JSON.stringify({ ok: false }) + '\n');
              return;
            }
            socket.end(JSON.stringify({ ok: true, data }) + '\n');
          } catch {
            // An exception may follow native admission. Never expose raw error data.
            socket.end(JSON.stringify({ ok: false }) + '\n');
          }
        })();
      });
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
    chmodSync(path, 0o600);
    return () => { abort.abort(); return new Promise(resolve => server.close(resolve)); };
  },
};
