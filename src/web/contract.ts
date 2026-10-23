import type { MessageAttachment } from '../ports/message-attachment.js';

/** Wire contracts shared by the web server and browser app. */
export interface TranscriptMessage {
  sequence: string;
  clientId?: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
  attachments?: MessageAttachment[];
  replyTo?: { sequence: string; role: 'user' | 'assistant'; excerpt: string };
}

export interface TranscriptPage {
  messages: TranscriptMessage[];
  cursor: string | null;
}

export interface CreatureStateEvent {
  state: 'thinking' | 'awake' | 'asleep';
  epoch: string;
  publishedAt: string;
}

export interface InstanceResponse {
  name: string;
  loaderUrl: string;
}

export interface MessageInput {
  id: string;
  text: string;
  replyTo?: string;
}

export interface MessageAcceptedResponse {
  streamId: string;
}

/**
 * The gateway's own health, reduced to the fields the owner's screen may see
 * (ADR-013 D6): safe codes only, no URL, no key, never an upstream body.
 */
export interface ModelStatusEvent {
  state: 'unknown' | 'ok' | 'down';
  outageSince: string | null;
  lastErrorCode: string | null;
}

export type TranscriptEvent =
  | { type: 'message'; data: TranscriptMessage }
  | { type: 'state'; data: CreatureStateEvent | null }
  | { type: 'model'; data: ModelStatusEvent | null };
