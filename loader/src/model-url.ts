/** Shared OpenAI-compatible endpoint joining rule (ADR-013 D2). */
export function modelEndpointUrl(
  baseUrl: string,
  endpoint: 'chat/completions' | 'models' = 'chat/completions'
): URL {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${endpoint}`;
  url.search = '';
  url.hash = '';
  return url;
}
