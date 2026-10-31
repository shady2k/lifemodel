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

/** Supported preference wins; unknown/missing preferences fall back to owner text, then English. */
export function taskOutcomeLanguage(
  preferred?: string | null,
  latestOwnerMessage = ''
): 'ru' | 'en' {
  const language = preferred?.trim().toLowerCase().split(/[-_]/)[0];
  if (language && ['ru', 'russian', 'русский'].includes(language)) return 'ru';
  if (language && ['en', 'english', 'английский'].includes(language)) return 'en';
  return /\p{Script=Cyrillic}/u.test(latestOwnerMessage) ? 'ru' : 'en';
}

/** Fixed owner-facing facts only; the unverified semantic summary is never repeated. */
export function taskOutcomeFallback(
  event: TaskOutcomeEvent,
  commandTexts: ReadonlyMap<string, string> = new Map(),
  language: 'ru' | 'en' = 'en'
): string {
  const ru = language === 'ru';
  const reasons: Record<string, string> = ru
    ? {
        completed:
          'Я получила файлы, но не смогла проверить их содержимое. Пока не могу подтвердить запрошенный результат.',
        timeout: 'Мне не хватило времени.',
        stopped: 'Я прекратила работу, не закончив её.',
        aborted: 'Я прекратила работу, не закончив её.',
        compute_missing: 'Я больше не смогла найти запущенную работу.',
        job_failed: 'Я столкнулась с ошибкой выполнения.',
        semantic_report_missing: 'Я не получила итогового подтверждения результата.',
        missing_result: 'Я не получила файл с результатом.',
        expected_outputs_missing: `Я не получила ожидаемые файлы: ${JSON.stringify(event.missingExpectedOutputs ?? [])}.`,
        checksum_mismatch: 'Я не смогла проверить контрольную сумму файла с результатом.',
        executor_failed: 'Я не смогла закончить выполнение.',
        launch_failed: 'Я не смогла начать выполнение.',
      }
    : {
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
  const reason =
    knownReason ??
    (ru ? 'Я не смогла уточнить причину.' : 'I could not confirm a more specific reason.');
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
    ? ru
      ? `\nНе дошли до моей запущенной работы и не были применены изменения: ${String(missed.length)}.${excerpts.length ? ` Изменения (цитаты): ${excerpts.join('; ')}.` : ''}`
      : `\n${String(missed.length)} ${missed.length === 1 ? 'change did' : 'changes did'} not reach my running work and ${missed.length === 1 ? 'was' : 'were'} not applied.${excerpts.length ? ` Changes (quoted): ${excerpts.join('; ')}.` : ''}`
    : '';
  const pending = uncertain.length
    ? ru
      ? `\nЯ не подтвердила включение изменений в ход работы: ${String(uncertain.length)}. Они могли не быть применены.`
      : `\n${String(uncertain.length)} ${uncertain.length === 1 ? 'change has' : 'changes have'} no confirmed turn insertion and may not have been applied.`
    : '';
  // A fallback did not inspect file contents; never turn the report into a result.
  const state =
    event.state === 'done'
      ? ''
      : ru
        ? 'Я не смогла завершить работу. '
        : 'I could not complete the work. ';
  return `${state}${reason}${delivery}${pending} ${ru ? 'Как мне продолжить?' : 'How would you like me to proceed?'}`;
}

/** A redo receipt or uncertain recovery never verifies the original contents. */
export function taskOutcomeRedoFallback(
  event: TaskOutcomeEvent,
  uncertain: boolean,
  language: 'ru' | 'en'
): string {
  if (!uncertain)
    return language === 'ru'
      ? 'Я не смогла проверить запрошенный результат. Я начала одну исправленную попытку и проверю её, прежде чем подтвердить результат.'
      : 'I could not verify the requested result. I have started one corrected attempt and will check it before confirming the result.';
  const delivered = event.objects
    .filter((object) => object.mark === 'result' || object.mark === 'artifact')
    .map(
      (object) =>
        `${JSON.stringify(object.name)} (${String(object.size)} ${language === 'ru' ? 'байт' : 'bytes'})`
    );
  const text =
    language === 'ru'
      ? 'Если я начала исправленную попытку, я сообщу о ней; я не смогла подтвердить её состояние, поэтому пока не могу подтвердить результат.'
      : 'If I started a corrected attempt, I will report on it; I could not confirm its state, so I cannot confirm the result yet.';
  return (
    text +
    (delivered.length
      ? `\n${language === 'ru' ? 'Полученные файлы (содержимое не проверено)' : 'Delivered files (contents unverified)'}: ${delivered.join('; ')}.`
      : '')
  );
}
