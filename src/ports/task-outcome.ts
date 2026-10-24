import type { TaskOutcomeEvent } from './tasks.js';
import { validateMessageAttachments, type MessageAttachment } from './message-attachment.js';

/** Terminal events are private data, not instructions or model-selected file IDs. */
export function validateTaskOutcome(value: unknown): TaskOutcomeEvent {
  if (!value || typeof value !== 'object') throw new Error('Invalid task outcome');
  const event = value as TaskOutcomeEvent;
  if (
    typeof event.taskId !== 'string' ||
    !event.taskId ||
    typeof event.outcomeKey !== 'string' ||
    !event.outcomeKey.startsWith('outcome_') ||
    event.outcomeKey.length > 256 ||
    !['done', 'failed', 'stopped'].includes(event.state) ||
    typeof event.reasonCode !== 'string' ||
    !event.reasonCode ||
    typeof event.summary !== 'string' ||
    !event.summary.trim() ||
    !Array.isArray(event.objects)
  )
    throw new Error('Invalid task outcome');
  for (const object of event.objects) {
    if (
      !object ||
      typeof object !== 'object' ||
      !['result', 'log', 'artifact'].includes(object.mark) ||
      typeof object.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(object.sha256)
    )
      throw new Error('Invalid task outcome object');
    if (
      typeof object.id !== 'string' ||
      !object.id ||
      typeof object.name !== 'string' ||
      !object.name ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0 ||
      (object.contentType !== undefined && typeof object.contentType !== 'string')
    )
      throw new Error('Invalid task outcome object');
  }
  if (event.state === 'done' && !event.objects.some((object) => object.mark === 'result'))
    throw new Error('Task outcome missing result');
  return event;
}

export function taskOutcomeAttachments(event: TaskOutcomeEvent): MessageAttachment[][] {
  if (event.state !== 'done') return [];
  const groups: MessageAttachment[][] = [];
  const results = event.objects.filter((object) => object.mark === 'result');
  for (let index = 0; index < results.length; index += 20) {
    groups.push(
      validateMessageAttachments(
        results.slice(index, index + 20).map((object) => ({
          artifactId: object.id,
          name: object.name,
          size: object.size,
          contentType: object.contentType ?? 'application/octet-stream',
        })),
        'assistant'
      )!
    );
  }
  return groups;
}
