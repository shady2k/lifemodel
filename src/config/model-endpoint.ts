/**
 * The model endpoint's own shape and its one rule (lifemodel-q4x.4.1).
 *
 * lifemodel talks to ONE OpenAI-compatible endpoint, with the model named per
 * role. It holds no key: the key is injected on the way out (Agent Vault,
 * lifemodel-q4x.3.*). This module is the single place that says what a
 * configured endpoint is and what a half-written one is missing, so the
 * settings interface (`src/settings/`) and the provider wiring
 * (`createLLMProvider` in `src/core/container.ts`) cannot disagree about it.
 */

/** The three roles lifemodel asks a model for. */
export const ENDPOINT_ROLES = ['fast', 'smart', 'motor'] as const;

export type EndpointRole = (typeof ENDPOINT_ROLES)[number];

/**
 * The endpoint as the config file holds it: a base URL and one model per role.
 * `null` is a value the file does not carry yet (the first start of every
 * instance has all four as `null`).
 */
export interface ModelEndpoint {
  baseUrl: string | null;
  fastModel: string | null;
  smartModel: string | null;
  motorModel: string | null;
}

/** The endpoint's fields, in the words the interface shows. */
export const ENDPOINT_FIELDS: readonly { field: keyof ModelEndpoint; label: string }[] = [
  { field: 'baseUrl', label: 'the endpoint base URL' },
  { field: 'fastModel', label: 'the fast model' },
  { field: 'smartModel', label: 'the smart model' },
  { field: 'motorModel', label: 'the motor role model' },
];

/** One field of the endpoint that is written on its own (a value, not a blank). */
export function isEndpointFieldSet(endpoint: ModelEndpoint): boolean {
  return ENDPOINT_FIELDS.some(({ field }) => (endpoint[field] ?? '') !== '');
}

/**
 * What the endpoint is missing, in the interface's words; empty when it is
 * configured.
 *
 * The rule: an endpoint is written as a whole or not at all. A blank endpoint
 * is the state of a first start (lifemodel starts and says so), and a
 * half-written one is refused with every missing field named - never filled in
 * from another field, and never silently ignored.
 */
export function endpointGaps(
  endpoint: ModelEndpoint
): { field: keyof ModelEndpoint; label: string }[] {
  if (!isEndpointFieldSet(endpoint)) return [];
  return ENDPOINT_FIELDS.filter(({ field }) => (endpoint[field] ?? '') === '');
}

/** Whether the endpoint is configured as a whole (and so serves models). */
export function isEndpointComplete(endpoint: ModelEndpoint): boolean {
  return isEndpointFieldSet(endpoint) && endpointGaps(endpoint).length === 0;
}
