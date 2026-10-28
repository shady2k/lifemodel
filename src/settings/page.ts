/**
 * The settings page (lifemodel-q4x.4.1): plain HTML, no frontend framework,
 * like the loader's own pages.
 *
 * It says what is set, what is missing, and where the keys and panic live. It
 * never contains a secret: no key of the endpoint is lifemodel's to show, and
 * the platform's model gateway injects it from OpenBao on the upstream leg.
 */
import { REASONING_EFFORTS } from '../config/reasoning-effort.js';
import { isEndpointComplete, isEndpointFieldSet } from '../config/model-endpoint.js';
import {
  SETTINGS_FIELDS,
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

/** The loader's address is instance-specific and supplied by the web configuration. */
export function loaderUrl(instanceName = 'lifemodel'): string {
  return `https://boot-${instanceName}.local/`;
}

const STYLE = `
    :root { color-scheme: light dark; }
    body { font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 44rem; padding: 0 1rem; line-height: 1.5; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.1rem; margin-top: 2rem; }
    form { margin-top: 1rem; }
    label { display: block; margin-top: 1rem; font-weight: 600; }
    input, select { width: 100%; padding: 0.4rem; font: inherit; box-sizing: border-box; }
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
  /** Configured instance identity; never inferred from the request Host. */
  instanceName?: string;
  /** Environment variables that override the saved values, by name only. */
  overriddenBy?: string[];
  /** Set after a save: the page confirms the config is applied. */
  saved?: boolean;
  /**
   * The endpoint the platform pins (ADR-013 D2), or null. Shown as it is and
   * not editable: swapping the model endpoint is the platform's act.
   */
  pinnedBaseUrl?: string | null;
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
  const pinned = field === 'endpointBaseUrl' && (options.pinnedBaseUrl ?? null) !== null;
  // Endpoint URLs are rendered in a redacted form.
  const value =
    field === 'endpointBaseUrl' ? redactEndpointUrl(options.values[field]) : options.values[field];
  const hints: Partial<Record<typeof field, string>> = {
    endpointBaseUrl: pinned
      ? 'This platform sets the model endpoint; it is not editable here. lifemodel talks to it and holds no key.'
      : 'The OpenAI-compatible endpoint lifemodel talks to, e.g. http://127.0.0.1:1234/v1',
    fastModel: 'The model for classification and quick decisions',
    smartModel: 'The model for reasoning and composing messages',
    motorModel: 'The model for Motor Cortex runs',
  };
  const effort = field.endsWith('ReasoningEffort');
  const hint = effort
    ? 'Blank sends no reasoning_effort; the gateway slot or upstream default applies. With the platform gateway pinned, prefer the slot setting and keep core role efforts blank. An explicit core role value goes to both slots, including the reserve during failover; both upstream models must support it. Saving this form with a blank or absent effort field clears that role effort.'
    : hints[field];
  const control = effort
    ? `<select id="${field}" name="${field}">${['', ...REASONING_EFFORTS].map((option) => `<option value="${option}"${option === (value ?? '') ? ' selected' : ''}>${option || 'Default (blank)'}</option>`).join('')}</select>`
    : `<input id="${field}" name="${field}" value="${escapeHtml(value ?? '')}"${pinned ? ' readonly' : ''} />`;
  return [
    `      <label for="${field}">${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</label>`,
    `      ${control}`,
    ...(hint === undefined ? [] : [`      <p class="hint">${escapeHtml(hint)}</p>`]),
    ...(error === undefined
      ? []
      : [`      <p class="error" id="${field}-error">${escapeHtml(error)}</p>`]),
  ].join('\n');
}

/** The whole page. */
export function renderSettingsPage(options: SettingsPageOptions): string {
  // A platform-pinned endpoint is configured by definition; the models are
  // optional beside it (a role left blank asks for `default`).
  const missing = (options.pinnedBaseUrl ?? null) === null ? endpointState(options.values) : [];
  const loader = loaderUrl(options.instanceName);

  const missingBlock =
    missing.length === 0
      ? ''
      : `      <p class="missing"><strong>No model endpoint is configured yet.</strong>
      lifemodel runs and serves this page, but it cannot talk to a model until the endpoint
      and its models are set. Missing: ${escapeHtml(missing.join(', '))}.</p>`;

  const savedBlock =
    options.saved === true
      ? `      <p class="missing"><strong>Saved.</strong> lifemodel is using these
      settings for future model requests. Reload this page in a moment to see them at work.</p>`
      : '';

  const pinnedBlock =
    (options.pinnedBaseUrl ?? null) === null
      ? ''
      : `      <p class="hint">This platform sets the model endpoint. A model left blank is
      asked for as <code>default</code>, and the gateway answers with the model configured
      for the endpoint it uses.</p>`;

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
    endpoint below. Saving them writes the instance's configuration to Postgres and
    applies the new model endpoint and models to the running core.</p>
    <p>Keys are not kept here. Put the endpoint and its key into the loader
    (<a href="${escapeHtml(loader)}">${escapeHtml(loader)}</a>): the platform keeps the key in
    OpenBao and its model gateway adds it on the way out. lifemodel holds no key.</p>
${savedBlock}${missingBlock}${pinnedBlock}${overrideBlock}
    <h2>The model endpoint</h2>
    <p>One OpenAI-compatible endpoint, with the model for each role. lifemodel holds no key:
    the key is injected on the way out.</p>
    <form method="post" action="/settings">
${SETTINGS_FIELDS.map((formField) => field(options, formField)).join('\n')}
      <button type="submit">Save settings</button>
    </form>
    <p class="hint">This page is behind the loader's login: no session, no request.</p>
  </body>
</html>
`;
}
