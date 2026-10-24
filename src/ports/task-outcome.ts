import type { TaskManifestObject, TaskOutcomeEvent } from './tasks.js';
import { validateMessageAttachments, type MessageAttachment } from './message-attachment.js';

/** Terminal events are private data, not instructions or model-selected file IDs. */
export function validateTaskOutcome(value: unknown): TaskOutcomeEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid task outcome');
  const event = value as Record<string, unknown>;
  if (
    typeof event['taskId'] !== 'string' ||
    !event['taskId'] ||
    typeof event['outcomeKey'] !== 'string' ||
    !event['outcomeKey'].startsWith('outcome_') ||
    event['outcomeKey'].length > 256 ||
    (event['state'] !== 'done' && event['state'] !== 'failed' && event['state'] !== 'stopped') ||
    typeof event['reasonCode'] !== 'string' ||
    !event['reasonCode'] ||
    typeof event['summary'] !== 'string' ||
    !event['summary'].trim() ||
    !Array.isArray(event['objects'])
  )
    throw new Error('Invalid task outcome');
  const objects = Array.from(event['objects'], (raw: unknown): TaskManifestObject => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('Invalid task outcome object');
    const object = raw as Record<string, unknown>;
    if (
      (object['mark'] !== 'result' && object['mark'] !== 'log' && object['mark'] !== 'artifact') ||
      typeof object['sha256'] !== 'string' ||
      !/^[a-f0-9]{64}$/.test(object['sha256']) ||
      typeof object['id'] !== 'string' ||
      !object['id'] ||
      typeof object['name'] !== 'string' ||
      !object['name'] ||
      typeof object['size'] !== 'number' ||
      !Number.isSafeInteger(object['size']) ||
      object['size'] < 0 ||
      (object['contentType'] !== undefined && typeof object['contentType'] !== 'string')
    )
      throw new Error('Invalid task outcome object');
    return {
      id: object['id'],
      name: object['name'],
      size: object['size'],
      sha256: object['sha256'],
      mark: object['mark'],
      ...(object['contentType'] !== undefined ? { contentType: object['contentType'] } : {}),
    };
  });
  if (event['state'] === 'done' && !objects.some((object) => object.mark === 'result'))
    throw new Error('Task outcome missing result');
  return {
    taskId: event['taskId'],
    outcomeKey: event['outcomeKey'],
    state: event['state'],
    reasonCode: event['reasonCode'],
    summary: event['summary'],
    objects,
  };
}

export function taskOutcomeAttachments(event: TaskOutcomeEvent): MessageAttachment[][] {
  if (event.state !== 'done') return [];
  const groups: MessageAttachment[][] = [];
  const results = event.objects.filter((object) => object.mark === 'result');
  for (let index = 0; index < results.length; index += 20) {
    const attachments = validateMessageAttachments(
      results.slice(index, index + 20).map((object) => ({
        artifactId: object.id,
        name: object.name,
        size: object.size,
        contentType: object.contentType ?? 'application/octet-stream',
      })),
      'assistant'
    );
    if (!attachments) throw new Error('Missing task result attachments');
    groups.push(attachments);
  }
  return groups;
}

/** Fixed owner-facing explanation; task text is quoted, never used as instructions. */
export function taskOutcomeFallback(event: TaskOutcomeEvent): string {
  const reasons: Record<string, string> = {
    completed: 'The work completed.',
    timeout: 'The task ran out of time.',
    stopped: 'The task was stopped.',
    aborted: 'The task stopped before finishing.',
    compute_missing: 'The running task could no longer be found.',
    job_failed: 'The task failed while running.',
    semantic_report_missing: 'The task ended without confirming its result.',
    missing_result: 'The task did not produce a result file.',
    checksum_mismatch: 'The result file could not be verified.',
    executor_failed: 'The task could not finish running.',
    launch_failed: 'The task could not start.',
  };
  const state =
    event.state === 'done'
      ? 'Task completed.'
      : event.state === 'stopped'
        ? 'Task stopped.'
        : 'Task failed.';
  const reason = reasons[event.reasonCode] ?? 'The task ended without a more specific explanation.';
  return `${state} ${reason}\nTask output (quoted): ${JSON.stringify(event.summary)}${event.state === 'done' ? '' : '\nNo completed result is available.'}`;
}
