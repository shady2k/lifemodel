/** Small HTTP answers shared by the loader's route handlers. */
import type { ServerResponse } from 'node:http';

export const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function redirect(
  res: ServerResponse,
  location: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
  res.end();
}
