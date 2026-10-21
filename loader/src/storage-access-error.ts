import { randomUUID } from 'node:crypto';
/** Deliberately carries no transport error, token, body or connection URL. */
export class StorageAccessError extends Error {
  readonly id = randomUUID();
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = 'StorageAccessError';
  }
}
