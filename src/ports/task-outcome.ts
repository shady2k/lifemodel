import type { TaskCommandDeliveryStatus } from './task-channel.js';
import { isTaskExpectedOutputs, type TaskManifestObject, type TaskOutcomeEvent } from './tasks.js';
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
  let commands: TaskCommandDeliveryStatus[] | undefined;
  if (event['commands'] !== undefined) {
    if (!Array.isArray(event['commands']) || event['commands'].length > 1024)
      throw new Error('Invalid task commands');
    commands = event['commands'].map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid task command');
      const c = raw as Record<string, unknown>;
      if (
        typeof c['commandId'] !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(c['commandId']) ||
        !['steer', 'answer'].includes(c['kind'] as string) ||
        !['queued', 'delivered', 'inserted', 'not_delivered', 'uncertain'].includes(
          c['delivery'] as string
        )
      )
        throw new Error('Invalid task command');
      return {
        commandId: c['commandId'],
        kind: c['kind'],
        delivery: c['delivery'],
      } as TaskCommandDeliveryStatus;
    });
  }
  for (const key of ['expectedOutputs', 'missingExpectedOutputs']) {
    if (event[key] !== undefined && !isTaskExpectedOutputs(event[key]))
      throw new Error('Invalid task expected outputs');
  }
  if (
    event['redoOf'] !== undefined &&
    (typeof event['redoOf'] !== 'string' || !event['redoOf'] || event['redoOf'].length > 128)
  )
    throw new Error('Invalid task redo');
  if (event['state'] === 'done' && !objects.some((object) => object.mark === 'result'))
    throw new Error('Task outcome missing result');
  return {
    taskId: event['taskId'],
    outcomeKey: event['outcomeKey'],
    state: event['state'],
    reasonCode: event['reasonCode'],
    summary: event['summary'],
    objects,
    ...(commands === undefined ? {} : { commands }),
    ...(event['expectedOutputs'] === undefined
      ? {}
      : { expectedOutputs: [...(event['expectedOutputs'] as string[])] }),
    ...(event['missingExpectedOutputs'] === undefined
      ? {}
      : { missingExpectedOutputs: [...(event['missingExpectedOutputs'] as string[])] }),
    ...(event['redoOf'] === undefined ? {} : { redoOf: event['redoOf'] }),
  };
}

export function taskOutcomeAttachments(event: TaskOutcomeEvent): MessageAttachment[][] {
  if (event.state !== 'done') return [];
  const groups: MessageAttachment[][] = [];
  // Only sealed owner-facing outputs are eligible. Logs stay private, and the
  // done validator still requires a result; artifacts never make a task succeed.
  const outputs = event.objects.filter(
    (object) => object.mark === 'result' || object.mark === 'artifact'
  );
  for (let index = 0; index < outputs.length; index += 20) {
    const attachments = validateMessageAttachments(
      outputs.slice(index, index + 20).map((object) => ({
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

/** Fixed owner-facing facts only; the unverified semantic summary is never repeated. */
export function taskOutcomeFallback(
  event: TaskOutcomeEvent,
  commandTexts: ReadonlyMap<string, string> = new Map()
): string {
  const reasons: Record<string, string> = {
    completed:
      'I received the delivered files, but could not verify their contents. I cannot confirm the requested result yet.',
    timeout: 'I ran out of time.',
    stopped: 'I stopped before finishing.',
    aborted: 'I stopped before finishing.',
    compute_missing: 'I could no longer find the running work.',
    job_failed: 'I encountered an execution failure.',
    semantic_report_missing: 'I did not receive a final result confirmation.',
    missing_result: 'I did not receive a result file.',
    expected_outputs_missing: `I did not receive the expected files: ${JSON.stringify(event.missingExpectedOutputs ?? [])}.`,
    checksum_mismatch: 'I could not verify the result file checksum.',
    executor_failed: 'I could not finish execution.',
    launch_failed: 'I could not start execution.',
  };
  const knownReason = Object.hasOwn(reasons, event.reasonCode)
    ? reasons[event.reasonCode]
    : undefined;
  const reason = knownReason ?? 'I could not confirm a more specific reason.';
  const missed = event.commands?.filter((c) => c.delivery === 'not_delivered') ?? [];
  const uncertain =
    event.commands?.filter((c) => ['queued', 'delivered', 'uncertain'].includes(c.delivery)) ?? [];
  const excerpts = missed
    .flatMap((command) => {
      const text = commandTexts.get(command.commandId);
      return typeof text === 'string' ? [JSON.stringify(text.slice(0, 160))] : [];
    })
    .slice(0, 8);
  const delivery = missed.length
    ? `\n${String(missed.length)} ${missed.length === 1 ? 'change did' : 'changes did'} not reach my running work and ${missed.length === 1 ? 'was' : 'were'} not applied.${excerpts.length ? ` Changes (quoted): ${excerpts.join('; ')}.` : ''}`
    : '';
  const pending = uncertain.length
    ? `\n${String(uncertain.length)} ${uncertain.length === 1 ? 'change has' : 'changes have'} no confirmed turn insertion and may not have been applied.`
    : '';
  // The semantic report is an untrusted claim. A fallback did not inspect
  // file contents, so it must never turn that claim into the owner's result.
  const state = event.state === 'done' ? '' : 'I could not complete the work. ';
  return `${state}${reason}${delivery}${pending} How would you like me to proceed?`;
}
