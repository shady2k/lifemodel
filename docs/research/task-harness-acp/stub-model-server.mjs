/**
 * Scripted OpenAI-compatible stub for the ACP harness probe.
 *
 * Serves only what the launcher's task relay forwards:
 *   POST /v1/chat/completions   (streaming and non-streaming)
 *   GET  /v1/models
 *
 * The relay (loader/src/task-model-relay.ts) accepts any caller auth, adds the
 * task token and forwards to a https origin, so this stub listens on TLS with a
 * self-signed certificate that the relay trusts through its CA file.
 *
 * Script: the first chat completion that carries no tool result answers with one
 * tool call whose name is taken from the agent's OWN tool list (each agent names
 * its shell differently) and whose arguments are built from that tool's JSON
 * schema. Every later completion answers with fixed text. Everything served is
 * appended to requests.jsonl so the doc can show the model traffic.
 *
 * Env: PROBE_PORT (default 8443), PROBE_CERT, PROBE_KEY, PROBE_LOG,
 *      PROBE_TOOL_COMMAND, PROBE_FINAL_TEXT, PROBE_MAX_TOOL_CALLS (default 1).
 */
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync, appendFileSync } from 'node:fs';

const port = Number(process.env.PROBE_PORT ?? 8443);
const log = process.env.PROBE_LOG ?? '/out/model-requests.jsonl';
const toolCommand = process.env.PROBE_TOOL_COMMAND ?? 'echo probe-tool-ok > /work/probe-tool-marker; echo probe-tool-ok';
const finalText = process.env.PROBE_FINAL_TEXT ?? 'PROBE_FINAL: the shell tool ran and the marker file exists.';
const maxToolCalls = Number(process.env.PROBE_MAX_TOOL_CALLS ?? 1);
const tls = process.env.PROBE_TLS === '1';
const cert = tls ? readFileSync(process.env.PROBE_CERT ?? '/certs/stub.crt') : undefined;
const key = tls ? readFileSync(process.env.PROBE_KEY ?? '/certs/stub.key') : undefined;

let served = 0;
const record = (entry) => appendFileSync(log, `${JSON.stringify(entry)}\n`);

const SHELL_NAMES = ['shell', 'bash', 'execute_shell', 'execute_command', 'run_command', 'run_shell', 'container_exec', 'linux_shell', 'exec', 'terminal', 'run_terminal_cmd'];
const COMMAND_KEYS = ['command', 'cmd', 'script', 'input', 'code', 'shell_command'];

/** Pick the agent's own shell tool and build one call that satisfies its schema. */
function toolCallFor(tools) {
  const list = (tools ?? []).filter((t) => t?.function?.name).map((t) => t.function);
  if (!list.length) return undefined;
  const python = list.find(t => t.name === 'python_repl');
  if (python) return {name: python.name, arguments: JSON.stringify({code: `handle = bash(${JSON.stringify(toolCommand)})\nresult = await handle\nprint(result.output)\nif result.exit_code != 0: raise RuntimeError(f'Shell exit {result.exit_code}')`})};
  const scored = list.map((fn) => {
    const name = String(fn.name).toLowerCase();
    let score = 0;
    if (SHELL_NAMES.includes(name)) score += 100;
    if (SHELL_NAMES.some((n) => name.includes(n))) score += 40;
    const props = Object.keys(fn.parameters?.properties ?? {}).map((k) => k.toLowerCase());
    if (props.some((k) => COMMAND_KEYS.includes(k))) score += 25;
    if (props.includes('command')) score += 10;
    return { fn, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const chosen = scored[0];
  if (!chosen || chosen.score === 0) return undefined;
  const schema = chosen.fn.parameters ?? { type: 'object', properties: {} };
  const props = schema.properties ?? {};
  const required = schema.required ?? Object.keys(props);
  const args = {};
  for (const key of Object.keys(props)) {
    const lower = key.toLowerCase();
    const type = props[key]?.type;
    if (COMMAND_KEYS.includes(lower) || (lower.endsWith('command') && type === 'string')) args[key] = toolCommand;
    else if (required.includes(key)) {
      if (type === 'string') args[key] = key.toLowerCase().includes('cwd') || lower === 'workdir' ? '/work' : 'probe';
      else if (type === 'number' || type === 'integer') args[key] = 0;
      else if (type === 'boolean') args[key] = false;
      else if (type === 'array') args[key] = [];
      else if (type === 'object') args[key] = {};
    }
  }
  if (!Object.values(args).includes(toolCommand)) {
    const key = Object.keys(props).find((k) => COMMAND_KEYS.includes(k.toLowerCase())) ?? 'command';
    args[key] = toolCommand;
  }
  return { name: chosen.fn.name, arguments: JSON.stringify(args), parameters: props };
}

function plan(body) {
  const messages = body.messages ?? [];
  const toolMessages = messages.filter((m) => m?.role === 'tool' || m?.role === 'function');
  const assistantToolCalls = messages.filter((m) => m?.role === 'assistant' && (m.tool_calls?.length ?? 0) > 0);
  const wantTool = toolMessages.length < maxToolCalls && assistantToolCalls.length < maxToolCalls;
  const call = wantTool ? toolCallFor(body.tools) : undefined;
  if (wantTool && !call) return { kind: 'text', text: `PROBE_NO_TOOL: no shell tool in ${(body.tools ?? []).length} tools offered.` };
  if (call) return { kind: 'tool', call };
  return { kind: 'text', text: finalText };
}

const usage = (prompt, completion) => ({
  prompt_tokens: Math.max(1, JSON.stringify(prompt).length >> 2),
  completion_tokens: Math.max(1, JSON.stringify(completion).length >> 2),
  total_tokens: Math.max(2, (JSON.stringify(prompt).length + JSON.stringify(completion).length) >> 2),
});

function completionBody(id, model, choice, prompt) {
  return { id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, choices: [choice], usage: usage(prompt, choice) };
}

function serve(req, res, body) {
  const id = `chatcmpl-probe-${++served}`;
  const model = body.model ?? 'lifemodel/task';
  const outcome = plan(body);
  record({
    at: new Date().toISOString(),
    method: req.method, url: req.url, relayTokenAccepted: req.headers['x-lifemodel-task-token'] === 'probe-placeholder-only',
    n: served,
    model,
    stream: Boolean(body.stream),
    messages: (body.messages ?? []).map((m) => ({ role: m.role, tool_calls: m.tool_calls?.map((c) => c.function?.name) ?? undefined, tool_call_id: m.tool_call_id })),
    tools: (body.tools ?? []).map((t) => t?.function?.name),
    decided: outcome.kind === 'tool' ? `tool:${outcome.call.name}` : 'text',
    selectedArguments: outcome.kind === 'tool' ? JSON.parse(outcome.call.arguments) : undefined,
  });
  if (outcome.kind === 'tool') {
    const choice = {
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: `call_probe_${served}`, type: 'function', function: { name: outcome.call.name, arguments: outcome.call.arguments } }] },
      finish_reason: 'tool_calls',
    };
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completionBody(id, model, choice, body.messages)));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const frame = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
    res.write(frame({ role: 'assistant', tool_calls: [{ index: 0, id: `call_probe_${served}`, type: 'function', function: { name: outcome.call.name, arguments: outcome.call.arguments } }] }));
    res.write(frame({}, 'tool_calls'));
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(completionBody(id, model, { index: 0, message: { role: 'assistant', content: outcome.text }, finish_reason: 'stop' }, body.messages)));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const frame = (delta, finish) => `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish ?? null }] })}\n\n`;
  res.write(frame({ role: 'assistant', content: '' }));
  for (const word of outcome.text.split(/(?<= )/)) res.write(frame({ content: word }));
  res.write(frame({}, 'stop'));
  res.write('data: [DONE]\n\n');
  res.end();
}

const handler = (req, res) => {
  if (req.method === 'GET' && req.url === '/v1/models') {
    record({at:new Date().toISOString(),method:req.method,url:req.url,relayTokenAccepted:req.headers['x-lifemodel-task-token']==='probe-placeholder-only'});
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'lifemodel/task', object: 'model' }] }));
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
    record({ at: new Date().toISOString(), unexpected: { method: req.method, url: req.url } });
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not_found"}');
    return;
  }
  if (process.env.PROBE_PROVIDER_ERROR === '1') {
    record({at:new Date().toISOString(),providerError:true,method:req.method,url:req.url});
    res.writeHead(400, {'content-type':'application/json'}).end('{"error":{"message":"PROBE_PROVIDER_FAILURE","type":"invalid_request_error"}}');
    return;
  }
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' }).end('{"error":"bad_json"}');
      return;
    }
    try {
      serve(req, res, body);
    } catch (error) {
      record({ at: new Date().toISOString(), error: String(error) });
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"stub_failed"}');
    }
  });
};
const server = tls ? createHttpsServer({ cert, key }, handler) : createHttpServer(handler);
server.listen(port, '127.0.0.1', () =>
  console.error(`[stub] ${tls ? 'https' : 'http'}://127.0.0.1:${port}/v1 ready (log ${log})`)
);
