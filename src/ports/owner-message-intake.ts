/** Durable owner-message intake operations for the web module. */
export type OwnerMessageAcceptance =
  | { status: 'accepted'; streamId: string }
  | { status: 'duplicate'; streamId: string }
  | { status: 'conflict' }
  | { status: 'stale' };

export interface IOwnerMessageIntake {
  acceptOwnerMessage(id: string, text: string, replyTo?: string): Promise<OwnerMessageAcceptance>;
}
