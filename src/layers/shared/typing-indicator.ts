/**
 * Shared typing indicator utility for layer processors.
 *
 * Extracted from CognitionProcessor and SmartProcessor to avoid duplication.
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '../../core/event-bus.js';
import type { Event } from '../../types/index.js';
import { Priority } from '../../types/index.js';
import type { Logger } from '../../types/logger.js';

/**
 * Emit a typing indicator event to a channel.
 *
 * @param eventBus - The event bus to publish to
 * @param chatId - The chat ID to send typing to
 * @param channel - The channel name (e.g., 'telegram')
 * @param logger - Optional logger for debug output
 */
export async function emitTypingIndicator(
  eventBus: EventBus | undefined,
  chatId: string,
  channel: string,
  logger?: Logger
): Promise<void> {
  if (!eventBus) return;

  const typingEvent: Event = {
    id: randomUUID(),
    source: 'internal',
    channel,
    type: 'typing_start',
    priority: Priority.HIGH,
    timestamp: new Date(),
    payload: { chatId },
  };

  await eventBus.publish(typingEvent);
  logger?.debug({ chatId, channel }, 'Typing indicator emitted');
}
