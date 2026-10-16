import { afterEach, describe, expect, it } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createTestLogger } from '../helpers/test-logger.js';
import { createSettingsServer, type SettingsServer } from '../../src/settings/server.js';
import type { AgentConfigFile } from '../../src/config/config-schema.js';
import { createReloadableLLMProvider } from '../../src/core/reloadable-llm-provider.js';
import type { CompletionRequest, CompletionResponse, LLMProvider } from '../../src/llm/provider.js';

let server: SettingsServer;
let document: AgentConfigFile | null;
let saved: number;
let liveProvider: ReturnType<typeof createReloadableLLMProvider>;

async function startServer(): Promise<void> {
  document = null;
  saved = 0;
  liveProvider = createReloadableLLMProvider(null);
  server = createSettingsServer({
    instanceName: 'custom',
    config: {
      readConfig: async () => document,
      writeConfig: async (value) => {
        document = value;
      },
    },
    logger: createTestLogger('silent'),
    port: 0,
    onSaved: () => {
      saved++;
      const endpoint = document?.llm?.endpoint;
      if (endpoint?.baseUrl) {
        const provider: LLMProvider = {
          name: 'endpoint',
          isAvailable: () => true,
          complete: async (request: CompletionRequest): Promise<CompletionResponse> => ({
            content: 'ok',
            model:
              request.role === 'smart' ? (endpoint.smartModel ?? '') : (endpoint.fastModel ?? ''),
          }),
        };
        liveProvider.replace(provider);
      }
    },
  });
  await server.listen();
}

afterEach(async () => {
  await server.close();
});

async function request(
  path: string,
  form?: Record<string, string>
): Promise<{ status: number; body: string }> {
  const port = Number(server.address().split(':').at(-1));
  const body = form ? new URLSearchParams(form).toString() : undefined;
  return await new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: body ? 'POST' : 'GET',
        headers: {
          Host: 'localhost:8080',
          ...(body
            ? {
                Origin: 'http://localhost:8080',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': String(Buffer.byteLength(body)),
              }
            : {}),
        },
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          text += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }));
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

const endpoint = {
  endpointBaseUrl: 'http://127.0.0.1:1234/v1',
  fastModel: 'fast-v2',
  smartModel: 'smart-v2',
  motorModel: 'motor-v2',
  telegramChatId: '',
  telegramBotToken: '__telegram_bot_token__',
};

describe('settings server writes its config boundary', () => {
  it('renders the configured loader name, independent of the Host port', async () => {
    await startServer();
    const result = await request('/');
    expect(result.body).toContain('http://boot-custom.local/');
    expect(result.body).not.toContain('boot-localhost');
  });

  it('renders an empty Postgres-backed document as unconfigured', async () => {
    await startServer();
    const result = await request('/');
    expect(result.status).toBe(200);
    expect(result.body).toContain('No model endpoint is configured yet');
  });

  it('saves endpoint and model names through the server, then reloads via read', async () => {
    await startServer();
    const response = await request('/settings', endpoint);
    expect(response.status).toBe(200);
    expect(response.body).toContain('Saved.');
    expect(document?.llm?.endpoint).toMatchObject({
      baseUrl: endpoint.endpointBaseUrl,
      fastModel: 'fast-v2',
      smartModel: 'smart-v2',
      motorModel: 'motor-v2',
    });
    expect(saved).toBe(1);
    const responseFromCore = await liveProvider.provider.complete({ role: 'fast', messages: [] });
    expect(responseFromCore.model).toBe('fast-v2');
    const fresh = await request('/');
    expect(fresh.body).toContain('fast-v2');
    expect(fresh.body).toContain('smart-v2');
  });

  it('refuses a model without its endpoint and names the missing field', async () => {
    await startServer();
    const result = await request('/settings', { ...endpoint, endpointBaseUrl: '' });
    expect(result.status).toBe(400);
    expect(result.body).toContain('the endpoint base URL is needed');
    expect(document).toBeNull();
    expect(saved).toBe(0);
  });

  it('refuses cross-origin and missing-origin writes', async () => {
    await startServer();
    const port = Number(server.address().split(':').at(-1));
    const result = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/settings',
          method: 'POST',
          headers: { Host: 'localhost:8080', Origin: 'https://elsewhere.test' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(result).toBe(403);
  });
});
