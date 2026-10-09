/**
 * The settings page (lifemodel-q4x.4.1): plain HTML, no frontend framework,
 * like the loader's own pages.
 *
 * It says what is set, what is missing, and where the keys and panic live. It
 * never contains a secret: the bot token field holds the Agent Vault
 * placeholder, and no key of the endpoint is lifemodel's to show.
 */
import { isEndpointComplete, isEndpointFieldSet } from '../config/model-endpoint.js';
import {
  SETTINGS_FIELDS,
  TELEGRAM_BOT_TOKEN_PLACEHOLDER,
  redactEndpointUrl,
  settingsEndpoint,
  type SettingsErrors,
  type SettingsInput,
} from './settings.js';

/** HTML-escape a value that goes into the page (the config is the owner's). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The loader's address for the same instance: the pinned boot host, same port. */
export function loaderUrl(host: string | undefined): string {
  // The port comes from the request (the instance may be published on any
  // port); the NAME is pinned to `boot.localhost`, never taken from the Host
  // header - the loader's own login does the same, and a name a request
  // supplies must never decide a link (docs/features/instance/loader.md).
  const groups = /:(?<port>\d+)$/.exec(host ?? '')?.groups;
  const port = groups?.['port'];
  return port === undefined ? 'http://boot.localhost/' : `http://boot.localhost:${port}/`;
}

const STYLE = `
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.1rem; margin-top: 2rem; }
    form { margin-top: 1rem; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input { width: 100%; padding: 0.4rem; font: inherit; box-sizing: border-box; }
    .hint { font-size: 0.9rem; opacity: 0.75; margin: 0.2rem 0 0; }
    .error { color: #b3261e; font-size: 0.9rem; margin: 0.2rem 0 0; }
    .missing { border: 1px solid currentColor; border-radius: 0.4rem; padding: 0.6rem 0.8rem; }
    button { margin-top: 1.5rem; padding: 0.5rem 1rem; font: inherit; }
    code { font-size: 0.95em; }
`;

export interface SettingsPageOptions {
  /** The values the form shows. */
  values: SettingsInput;
  /** What is wrong with them; empty on a first render. */
  errors?: SettingsErrors;
  /** The request's Host header (only its port is used, for the loader's link). */
  host?: string | undefined;
  /** Environment variables that override the saved values, by name only. */
  overriddenBy?: string[];
  /** Set after a save: the page says lifemodel is restarting. */
  saved?: boolean;
}

/** What the endpoint is missing, in the page's words (empty when configured). */
function endpointState(values: SettingsInput): string[] {
  const endpoint = settingsEndpoint(values);
  if (!isEndpointFieldSet(endpoint)) {
    return ['the endpoint base URL', 'the fast model', 'the smart model', 'the motor role model'];
  }
  if (isEndpointComplete(endpoint)) {
    return [];
  }
  const missing: string[] = [];
  if (endpoint.baseUrl === null) missing.push('the endpoint base URL');
  if (endpoint.fastModel === null) missing.push('the fast model');
  if (endpoint.smartModel === null) missing.push('the smart model');
  if (endpoint.motorModel === null) missing.push('the motor role model');
  return missing;
}

function field(options: SettingsPageOptions, formField: (typeof SETTINGS_FIELDS)[number]): string {
  const { field, label } = formField;
  const error = options.errors?.[field];
  // A refused bot token is NEVER echoed back: the owner may have pasted the
  // real one, and a page (or a browser cache, or a log of the exchange) must
  // not hold it. An accepted one is a placeholder by the rule above.
  // Echoed values hold no secret: a refused bot token is dropped, and a
  // refused endpoint base URL is echoed without its credentials (the parts
  // before the @) — the owner sees the URL, never what it carried.
  const value =
    field === 'telegramBotToken' && error !== undefined
      ? ''
      : field === 'endpointBaseUrl' && error !== undefined
        ? redactEndpointUrl(options.values[field])
        : options.values[field];
  const hints: Partial<Record<typeof field, string>> = {
    endpointBaseUrl:
      'The OpenAI-compatible endpoint lifemodel talks to, e.g. http://127.0.0.1:1234/v1',
    fastModel: 'The model for classification and quick decisions',
    smartModel: 'The model for reasoning and composing messages',
    motorModel: 'The model for Motor Cortex runs',
    telegramChatId: 'Your Telegram chat id (@userinfobot gives it)',
    telegramBotToken: `The Agent Vault placeholder that stands for your token (default ${TELEGRAM_BOT_TOKEN_PLACEHOLDER}). The token itself goes into Agent Vault, never here.`,
  };
  const hint = hints[field];
  return [
    `      <label for="${field}">${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</label>`,
    `      <input id="${field}" name="${field}" value="${escapeHtml(value)}" />`,
    ...(hint === undefined ? [] : [`      <p class="hint">${escapeHtml(hint)}</p>`]),
    ...(error === undefined
      ? []
      : [`      <p class="error" id="${field}-error">${escapeHtml(error)}</p>`]),
  ].join('\n');
}

/** The whole page. */
export function renderSettingsPage(options: SettingsPageOptions): string {
  const missing = endpointState(options.values);
  const loader = loaderUrl(options.host);

  const missingBlock =
    missing.length === 0
      ? ''
      : `      <p class="missing"><strong>No model endpoint is configured yet.</strong>
      lifemodel runs and serves this page, but it cannot talk to a model until the endpoint
      and its models are set. Missing: ${escapeHtml(missing.join(', '))}.</p>`;

  const savedBlock =
    options.saved === true
      ? `      <p class="missing"><strong>Saved.</strong> lifemodel is restarting with these
      settings; the loader starts it again at once. Reload this page in a moment to see them at work.</p>`
      : '';

  const overrideBlock =
    (options.overriddenBy ?? []).length === 0
      ? ''
      : `      <p class="hint">An environment variable of this instance overrides the saved value
      and wins: ${escapeHtml((options.overriddenBy ?? []).join(', '))}.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>lifemodel settings</title>
    <style>${STYLE}    </style>
  </head>
  <body>
    <h1>lifemodel settings</h1>
    <p>These settings belong to this lifemodel instance, and they are its own: the model
    endpoint and the Telegram fields below. Saving them writes the instance's config file and
    restarts lifemodel through the loader, so the next start runs with them.</p>
    <p>Keys are not kept here. Put them into Agent Vault, reached through the loader
    (<a href="${escapeHtml(loader)}">${escapeHtml(loader)}</a>) - the same place panic and resume live.
    lifemodel holds the Agent Vault placeholder only, never a key.</p>
${savedBlock}${missingBlock}${overrideBlock}
    <h2>The model endpoint</h2>
    <p>One OpenAI-compatible endpoint, with the model for each role. lifemodel holds no key:
    the key is injected on the way out.</p>
    <form method="post" action="/settings">
${SETTINGS_FIELDS.map((formField) => field(options, formField)).join('\n')}
      <button type="submit">Save and restart lifemodel</button>
    </form>
    <p class="hint">This page is behind the loader's login: no session, no request.</p>
  </body>
</html>
`;
}
