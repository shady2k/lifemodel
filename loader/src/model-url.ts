/** Shared OpenAI-compatible endpoint joining rule (ADR-013 D2). */
export function modelEndpointUrl(
  baseUrl: string,
  endpoint: 'chat/completions' | 'models' = 'chat/completions'
): URL {
  const url = new URL(baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  url.pathname = `${url.pathname}${endpoint}`.replace(/\/{2,}/g, '/');
  url.search = '';
  url.hash = '';
  return url;
}
