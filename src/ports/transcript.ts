/** Owner-visible transcript row; internal conversation events are never exposed. */
export interface TranscriptRow {
  sequence: string;
  clientId?: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  replyTo?: string;
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
}
