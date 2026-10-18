/**
 * The platform's pin on the model endpoint (ADR-013 D2).
 *
 * The platform names the model endpoint by environment; that value overrides
 * what the settings document holds and is not editable in lifemodel's own
 * settings. lifemodel therefore holds no key and one endpoint.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigLoader } from '../../src/config/config-loader.js';
import type { AgentConfigFile } from '../../src/config/config-schema.js';
import {
  PINNED_MODEL_BASE_URL_ENV,
  pinnedModelBaseUrl,
  withPinnedBaseUrl,
} from '../../src/config/model-endpoint.js';
import {
  applySettings,
  settingsInputFromFile,
  validateSettings,
} from '../../src/settings/settings.js';

const GATEWAY = 'http://model-gateway.lifemodel-system.svc:8080/v1';

const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of [PINNED_MODEL_BASE_URL_ENV, 'LLM_ENDPOINT_BASE_URL']) delete process.env[key];
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
});

/** A config document holding another endpoint, as an owner could have saved it. */
const document = (baseUrl: string): AgentConfigFile => ({
  version: 1,
  llm: { endpoint: { baseUrl, fastModel: 'fast', smartModel: 'smart', motorModel: 'motor' } },
});

function loaderFor(file: AgentConfigFile | null): ConfigLoader {
  return new ConfigLoader({
    read: async () => file,
    write: async () => undefined,
  });
}

describe('the platform-pinned model endpoint', () => {
  it('is unset when the environment names none', () => {
    expect(pinnedModelBaseUrl({})).toBeNull();
    expect(
      withPinnedBaseUrl(
        { baseUrl: 'http://x/v1', fastModel: null, smartModel: null, motorModel: null },
        null
      )
    ).toEqual({ baseUrl: 'http://x/v1', fastModel: null, smartModel: null, motorModel: null });
  });

  it('overrides the endpoint the settings document holds', async () => {
    process.env[PINNED_MODEL_BASE_URL_ENV] = GATEWAY;
    const config = await loaderFor(document('http://owner.example:1234/v1')).load();
    expect(config.llm.endpoint.baseUrl).toBe(GATEWAY);
    // The roles stay the owner's: only the endpoint is the platform's.
    expect(config.llm.endpoint.fastModel).toBe('fast');
  });

  it('refuses two different endpoints named at once', async () => {
    process.env[PINNED_MODEL_BASE_URL_ENV] = GATEWAY;
    process.env['LLM_ENDPOINT_BASE_URL'] = 'http://elsewhere.example/v1';
    await expect(loaderFor(document('http://owner.example:1234/v1')).load()).rejects.toThrow(
      /name two different model endpoints/
    );
  });

  it('accepts the same endpoint named through the old override as well', async () => {
    process.env[PINNED_MODEL_BASE_URL_ENV] = GATEWAY;
    process.env['LLM_ENDPOINT_BASE_URL'] = GATEWAY;
    const config = await loaderFor(document('http://owner.example:1234/v1')).load();
    expect(config.llm.endpoint.baseUrl).toBe(GATEWAY);
  });

  it('is not editable in the settings interface, and shows the pinned endpoint', () => {
    const input = {
      endpointBaseUrl: 'http://owner.example:1234/v1',
      fastModel: 'fast',
      smartModel: 'smart',
      motorModel: 'motor',
    };
    expect(validateSettings(input, { pinnedBaseUrl: GATEWAY })).toMatchObject({
      endpointBaseUrl: expect.stringContaining(PINNED_MODEL_BASE_URL_ENV),
    });
    // The pinned value itself is accepted (the page posts the field back).
    expect(
      validateSettings({ ...input, endpointBaseUrl: GATEWAY }, { pinnedBaseUrl: GATEWAY })
    ).toEqual({});
    expect(settingsInputFromFile(document('http://owner.example:1234/v1'), GATEWAY)).toMatchObject({
      endpointBaseUrl: GATEWAY,
    });
    // The document keeps no base URL while the platform names the endpoint.
    expect(
      applySettings(document('http://owner.example:1234/v1'), input, GATEWAY).llm?.endpoint
    ).toEqual({ baseUrl: null, fastModel: 'fast', smartModel: 'smart', motorModel: 'motor' });
  });
});
