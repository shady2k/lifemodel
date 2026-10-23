import type { Readable } from 'node:stream';

/** Bytes only after storage-module authorization. Metadata remains in the transcript. */
export interface TaskArtifactReader {
  openTaskArtifact(
    artifactId: string,
    range: string | undefined,
    signal: AbortSignal
  ): Promise<{ body: Readable; size: number; start: number; end: number; partial: boolean }>;
}

/** Fresh check against the loader, never local decoding of the owner's cookie. */
export interface OwnerDownloadSessions {
  verify(cookie: string | undefined, signal: AbortSignal): Promise<boolean>;
}

export class ArtifactUnavailableError extends Error {
  constructor(readonly status: 404 | 416 | 503) {
    super('artifact_not_available');
  }
}

export const ARTIFACT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const MAX_ARTIFACT_RANGE_BYTES = 4 * 1024 * 1024;

/** One closed, explicit range only. No suffix, unbounded end, or multi-range. */
export function validArtifactRange(range: string): boolean {
  const match = /^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.exec(range);
  if (!match) return false;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end >= start &&
    end - start + 1 <= MAX_ARTIFACT_RANGE_BYTES
  );
}
