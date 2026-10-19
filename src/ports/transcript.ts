/** Owner-visible transcript row; internal conversation events are never exposed. */
export interface TranscriptRow {
  sequence: string;
  clientId?: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  replyTo?: { sequence: string; role: 'user' | 'assistant'; excerpt: string };
}

export interface TranscriptPage {
  rows: TranscriptRow[];
  /** Newest visible sequence for the recipient, including for the latest page. */
  cursor: string | null;
}

export interface ReadTranscriptOptions {
  before?: string;
  after?: string;
  limit: number;
}

/** Narrow read-only operations required by the owner web module. */
export interface TranscriptReader {
  readTranscript(options: ReadTranscriptOptions): Promise<TranscriptPage>;
  watchTranscript(after: string, signal?: AbortSignal): AsyncIterable<TranscriptRow>;
  /**
   * Takes one of the session's stream slots until `expiresAt`. An open stream
   * renews its lease, so a connection that dies without releasing it frees its
   * slot within one renewal window rather than blocking the next page.
   */
  acquireStreamLease(session: string, expiresAt: number): Promise<string | null>;
  /** Extends a held lease; false when the store no longer holds it. */
  renewStreamLease(session: string, leaseId: string, expiresAt: number): Promise<boolean>;
  releaseStreamLease(session: string, leaseId: string): Promise<void>;
}
