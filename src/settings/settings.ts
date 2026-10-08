/**
 * lifemodel's own settings: the values, their rules and the config file's shape
 * they are written to (lifemodel-q4x.4.1).
 *
 * lifemodel serves this interface on the root host, behind Caddy and the
 * loader's login, and it has NO auth of its own: the loader checks every
 * request before it arrives (docs/features/instance/settings.md). Saving
 * writes lifemodel's config file and asks the loader to start lifemodel again,
 * so the new values are what the next start reads - the agent is not
 * reconfigured underneath a running turn.
 */
import { CONFIG_FILE_VERSION, type AgentConfigFile } from '../config/config-schema.js';
import { endpointGaps, isEndpointFieldSet, type ModelEndpoint } from '../config/model-endpoint.js';

/** The default Agent Vault placeholder of a Telegram bot token. */
export const TELEGRAM_BOT_TOKEN_PLACEHOLDER = '__telegram_bot_token__';

/** What the form holds, as it arrives (every field a string, possibly empty). */
export interface SettingsInput {
  endpointBaseUrl: string;
  fastModel: string;
  smartModel: string;
  motorModel: string;
  telegramChatId: string;
  telegramBotToken: string;
}

/** A field of the form. */
export type SettingsField = keyof SettingsInput;

/** What is wrong with the input: the field's name and one sentence, or nothing. */
export type SettingsErrors = Partial<Record<SettingsField, string>>;

/** The form's fields with the words the page uses for them. */
export const SETTINGS_FIELDS: readonly { field: SettingsField; label: string }[] = [
  { field: 'endpointBaseUrl', label: 'the endpoint base URL' },
  { field: 'fastModel', label: 'the fast model' },
  { field: 'smartModel', label: 'the smart model' },
  { field: 'motorModel', label: 'the motor role model' },
  { field: 'telegramChatId', label: 'the Telegram chat id' },
  { field: 'telegramBotToken', label: 'the Telegram bot token' },
];

/** The Agent Vault placeholder shape: `__something__`, never a token. */
const PLACEHOLDER = /^__[A-Za-z0-9_]+__$/;

/** An http(s) URL, the only thing lifemodel can send a request to. */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The endpoint the form describes, with blanks as `null` (not configured). */
export function settingsEndpoint(input: SettingsInput): ModelEndpoint {
  const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim());
  return {
    baseUrl: blank(input.endpointBaseUrl),
    fastModel: blank(input.fastModel),
    smartModel: blank(input.smartModel),
    motorModel: blank(input.motorModel),
  };
}

/**
 * What is wrong with the input, per field - empty when it is all accepted.
 *
 * Every rule names its field: a value is never silently dropped, corrected or
 * replaced by another field's. An endpoint is written as a whole or not at all
 * (a model without a base URL is refused by the field it is missing, and an
 * empty model with a base URL by its own).
 */
export function validateSettings(input: SettingsInput): SettingsErrors {
  const errors: SettingsErrors = {};
  const endpoint = settingsEndpoint(input);

  if (endpoint.baseUrl !== null && !isHttpUrl(endpoint.baseUrl)) {
    errors.endpointBaseUrl = 'the endpoint base URL must be an http or https URL';
  }

  if (isEndpointFieldSet(endpoint)) {
    for (const gap of endpointGaps(endpoint)) {
      // The form names the base URL field `endpointBaseUrl`; the rest match.
      const target: SettingsField = gap.field === 'baseUrl' ? 'endpointBaseUrl' : gap.field;
      errors[target] = `${gap.label} is needed when the endpoint is set`;
    }
  }

  const chatId = input.telegramChatId.trim();
  if (chatId !== '' && !/^-?\d+$/.test(chatId)) {
    errors.telegramChatId = 'the Telegram chat id must be a number (get it from @userinfobot)';
  }

  const token = input.telegramBotToken.trim();
  if (token !== '' && !PLACEHOLDER.test(token)) {
    errors.telegramBotToken =
      'the Telegram bot token must be an Agent Vault placeholder like __telegram_bot_token__; the token itself belongs in Agent Vault, not here';
  }

  return errors;
}

/** Read the form's fields out of a submitted body, blank where a field is absent. */
export function settingsInputFromBody(body: Record<string, unknown>): SettingsInput {
  const read = (field: SettingsField): string => {
    const value = body[field];
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    endpointBaseUrl: read('endpointBaseUrl'),
    fastModel: read('fastModel'),
    smartModel: read('smartModel'),
    motorModel: read('motorModel'),
    telegramChatId: read('telegramChatId'),
    telegramBotToken: read('telegramBotToken'),
  };
}

/** The form's values as the config file holds them (what the page renders). */
export function settingsInputFromFile(file: AgentConfigFile | null): SettingsInput {
  const endpoint = file?.llm?.endpoint;
  return {
    endpointBaseUrl: endpoint?.baseUrl ?? '',
    fastModel: endpoint?.fastModel ?? '',
    smartModel: endpoint?.smartModel ?? '',
    motorModel: endpoint?.motorModel ?? '',
    telegramChatId: file?.primaryUser?.telegramChatId ?? '',
    telegramBotToken: file?.telegram?.botToken ?? TELEGRAM_BOT_TOKEN_PLACEHOLDER,
  };
}

/**
 * The config file with these settings applied, and every OTHER field of the
 * file kept exactly as it was: the owner's identity, plugin configuration and
 * anything a later version adds are not this interface's to drop.
 */
export function applySettings(file: AgentConfigFile | null, input: SettingsInput): AgentConfigFile {
  const endpoint = settingsEndpoint(input);
  const primaryUser = { ...(file?.primaryUser ?? {}) };
  if (input.telegramChatId.trim() === '') {
    delete primaryUser.telegramChatId;
  } else {
    primaryUser.telegramChatId = input.telegramChatId.trim();
  }
  return {
    ...(file ?? {}),
    version: file?.version ?? CONFIG_FILE_VERSION,
    llm: {
      ...(file?.llm ?? {}),
      endpoint: {
        baseUrl: endpoint.baseUrl,
        fastModel: endpoint.fastModel,
        smartModel: endpoint.smartModel,
        motorModel: endpoint.motorModel,
      },
    },
    primaryUser,
    telegram: { ...(file?.telegram ?? {}), botToken: input.telegramBotToken.trim() },
  };
}
