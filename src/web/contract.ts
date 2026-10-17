/** Wire contracts shared by the web server and browser app. */
export interface TranscriptMessage {
  sequence: string;
  clientId?: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string;
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

export type TranscriptEvent =
  | { type: 'message'; data: TranscriptMessage }
  | { type: 'state'; data: CreatureStateEvent | null };
