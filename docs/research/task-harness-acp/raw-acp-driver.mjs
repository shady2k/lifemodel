/**
 * Minimal ACP client for the probe: the same JSON-RPC messages
 * loader/src/task-acp.ts sends (initialize protocolVersion 1, session/new,
 * session/prompt, session/cancel, and the permission answer
 * {"outcome":{"outcome":"cancelled"}}), with no harness policy in the way.
 *
 * It exists to read facts the real client deliberately hides: the agent's own
 * stopReason, every session/update kind, and whether the agent asks the client
 * for permission at all. The real client's verdict is measured separately
 * (real-client-driver.mjs).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync, rmSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_FRAME = 4 * 1024 * 1024;

export function prepareWorkspace(workDirectory) {
  for (const name of ['home', 'tmp']) mkdirSync(join(workDirectory, name), { recursive: true, mode: 0o700 });
}

export function agentEnv(candidate, { baseURL, workDirectory }) {
  return {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: join(workDirectory, 'home'),
    TMPDIR: join(workDirectory, 'tmp'),
    ...candidate.configure({ relayBaseURL: baseURL, workDirectory }),
  };
}

/** ACP line-delimited JSON-RPC session against one agent process. */
export class AcpConnection {
  constructor({ candidate, env, workDirectory, transcript, timeoutMs = 180000 }) {
    this.candidate = candidate;
    this.env = env;
    this.workDirectory = workDirectory;
    this.transcript = transcript;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.nextId = 0;
    this.updates = [];
    this.permissionRequests = [];
    this.stderr = '';
    this.closed = false;
    this.promptSettled = false;
    this.onUpdate = undefined;
    this.onRequest = undefined;
  }

  record(dir, message) {
    appendFileSync(this.transcript, `${JSON.stringify({ at: new Date().toISOString(), dir, message })}\n`);
  }

  write(message) {
    this.record('out', message);
    return new Promise((resolve) => this.child.stdin.write(`${JSON.stringify(message)}\n`, resolve));
  }

  request(method, params, deadline = this.timeoutMs) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout:${method}`)), deadline);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      void this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  async start() {
    const { candidate } = this;
    this.child = spawn(candidate.command, candidate.args, {
      cwd: this.workDirectory,
      env: this.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (chunk) => {
      if (this.stderr.length < 200000) this.stderr += chunk.toString();
    });
    let buffered = '';
    this.child.stdout.on('data', (chunk) => {
      buffered += chunk.toString('utf8');
      if (Buffer.byteLength(buffered) > MAX_FRAME) this.fail(new Error('frame_limit'));
      let newline;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.fail(new Error('bad_frame'));
          return;
        }
        this.record('in', message);
        this.dispatch(message).catch((error) => this.fail(error));
      }
    });
    this.child.stdout.on('end', () => {
      if (!this.promptSettled && !this.closed) this.fail(new Error('stdout_closed'));
    });
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal };
      if (!this.closed && !this.promptSettled) this.fail(new Error(`process_exit:${code ?? signal}`));
    });
    // Give the process a moment to settle before the first write.
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  fail(error) {
    if (this.fault) return;
    this.fault = error;
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }

  async dispatch(message) {
    if (message.jsonrpc !== '2.0') throw new Error('protocol_error');
    if (message.method === 'session/update') {
      const update = message.params?.update ?? {};
      this.updates.push({ at: Date.now(), kind: update.sessionUpdate, status: update.status, toolCallId: update.toolCallId });
      await this.onUpdate?.(update);
      return;
    }
    if (typeof message.method === 'string') {
      if (!Object.hasOwn(message, 'id')) return; // notification
      const handler = this.onRequest;
      if (handler) {
        const answer = await handler(message);
        if (answer !== undefined) {
          await this.write({ jsonrpc: '2.0', id: message.id, result: answer });
          return;
        }
      }
      await this.write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not supported' },
      });
      return;
    }
    const waiter = this.pending.get(message.id);
    if (!waiter) throw new Error('protocol_error');
    this.pending.delete(message.id);
    if (message.error) waiter.reject(new Error(`rpc_error:${JSON.stringify(message.error)}`));
    else waiter.resolve(message.result ?? {});
  }

  async close() {
    this.closed = true;
    try {
      process.kill(-this.child.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      process.kill(-this.child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/**
 * One ACP run. Returns the facts the doc needs: the agent's stopReason, every
 * update kind, whether it asked for permission, and whether a cancelled tool
 * really stopped.
 */
export async function runRawAcp({ candidate, env, workDirectory, outFile, scenario, toolCommand, cancelAfterMs = 4000 }) {
  const transcript = `${outFile}.transcript.jsonl`;
  rmSync(transcript, { force: true });
  const marker = join(workDirectory, 'probe-tool-marker');
  rmSync(marker, { force: true });
  const connection = new AcpConnection({ candidate, env, workDirectory, transcript, timeoutMs: 60000 });
  const result = { candidate: candidate.label, scenario, transcript, markerCreated: false };
  try {
    await connection.start();
    const initialized = await connection.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'lifemodel-probe', version: '1' },
    });
    result.initialize = {
      protocolVersion: initialized.protocolVersion,
      agentInfo: initialized.agentInfo ?? null,
      authMethods: (initialized.authMethods ?? []).map((m) => m.id ?? m.type ?? null),
      capabilities: initialized.agentCapabilities ?? null,
    };
    const created = await connection.request('session/new', { cwd: workDirectory, mcpServers: [] });
    result.sessionId = created.sessionId;
    result.sessionNewResultKeys = Object.keys(created);
    connection.onRequest = async (message) => {
      if (message.method !== 'session/request_permission') return undefined;
      connection.permissionRequests.push(message.params);
      if (scenario === 'permission-allow') {
        const option = message.params?.options?.find(o => o.kind === 'allow_once');
        if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }
      // The real client's exact answer: a noninteractive denial.
      return { outcome: { outcome: 'cancelled' } };
    };
    let cancelledAt; let cancelSentAt; let liveAtCancel;
    connection.onUpdate = async (update) => {
      if (scenario !== 'cancel' || cancelledAt) return;
      const running = update.status === 'pending' || update.status === 'in_progress' || (update.sessionUpdate === 'tool_call' && update.status == null);
      if ((update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') && running) {
        cancelledAt = Date.now();
        setTimeout(() => {
          cancelSentAt = Date.now();
          const shellFile = join(workDirectory,'probe-shell-pid');
          const childFile = join(workDirectory,'probe-child-pid');
          const shellPid = existsSync(shellFile) ? Number(readFileSync(shellFile,'utf8').trim()) : null;
          const childPid = existsSync(childFile) ? Number(readFileSync(childFile,'utf8').trim()) : null;
          liveAtCancel = {startMarker:existsSync(join(workDirectory,'probe-start-marker')),
            shellPid, childPid, shellAlive:shellPid ? existsSync(`/proc/${shellPid}`) : false,
            childAlive:childPid ? existsSync(`/proc/${childPid}`) : false};
          void connection.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: created.sessionId } });
        }, cancelAfterMs);
      }
    };
    const started = Date.now();
    const response = await connection.request(
      'session/prompt',
      { sessionId: created.sessionId, prompt: [{ type: 'text', text: 'Run the shell tool, then report the result.' }] },
      60000
    );
    result.durationMs = Date.now() - started;
    connection.promptSettled = true;
    result.stopReason = response?.stopReason ?? null;
    result.promptResponseKeys = Object.keys(response ?? {});
    result.toolObservedAfterMs = cancelledAt ? cancelledAt - started : null;
    result.cancelSentAfterMs = cancelSentAt ? cancelSentAt - started : null;
    result.liveAtCancel = liveAtCancel ?? null;
    // Keep the ACP agent and strace alive beyond the shell's original 30-second
    // lifetime. Killing the agent first would mask a failed session/cancel.
    const pidPath = join(workDirectory, 'probe-shell-pid');
    if (existsSync(pidPath)) {
      result.shellPid = Number(readFileSync(pidPath, 'utf8').trim());
      result.shellAliveAtPromptReturn = existsSync(`/proc/${result.shellPid}`);
    }
    const childPidPath = join(workDirectory, 'probe-child-pid');
    if (existsSync(childPidPath)) {
      result.childPid = Number(readFileSync(childPidPath, 'utf8').trim());
      result.childAliveAtPromptReturn = existsSync(`/proc/${result.childPid}`);
      if (result.childAliveAtPromptReturn) result.childStatAtPromptReturn = readFileSync(`/proc/${result.childPid}/stat`, 'utf8');
    }
    result.startMarker = existsSync(join(workDirectory, 'probe-start-marker'));
    if (scenario === 'cancel') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      if (result.childPid) {
        result.childAliveTwoSecondsAfterReturn = existsSync(`/proc/${result.childPid}`);
        if (result.childAliveTwoSecondsAfterReturn) result.childStatTwoSecondsAfterReturn = readFileSync(`/proc/${result.childPid}/stat`, 'utf8');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, scenario === 'cancel' ? 30000 : 1000));
    if (result.shellPid) result.shellAliveAfterObservation = existsSync(`/proc/${result.shellPid}`);
    if (result.childPid) {
      result.childAliveAfterObservation = existsSync(`/proc/${result.childPid}`);
      if (result.childAliveAfterObservation) result.childStatAfterObservation = readFileSync(`/proc/${result.childPid}/stat`, 'utf8');
    }
    result.markerCreated = existsSync(marker);
    result.completionMarker = existsSync(join(workDirectory, 'probe-cancel-marker'));
    result.updateKinds = connection.updates.reduce((acc, update) => {
      acc[update.kind] = (acc[update.kind] ?? 0) + 1;
      return acc;
    }, {});
    result.toolCallStatuses = connection.updates.filter((u) => u.toolCallId).map((u) => `${u.kind}:${u.status ?? '-'}`);
    result.permissionRequests = connection.permissionRequests.map((params) => ({
      sessionId: params?.sessionId,
      toolCall: params?.toolCall
        ? { title: params.toolCall.title, kind: params.toolCall.kind, status: params.toolCall.status }
        : null,
      optionIds: (params?.options ?? []).map((o) => `${o.optionId}:${o.kind}`),
    }));
    result.exitAfterPrompt = connection.exit ?? null;
  } catch (error) {
    result.error = String(error?.message ?? error);
  } finally {
    await connection.close();
    result.processExit = connection.exit ?? null;
    result.stderrTail = connection.stderr.split('\n').slice(-25).join('\n');
  }
  return result;
}
