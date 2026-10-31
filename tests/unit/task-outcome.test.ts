import { describe, expect, it } from 'vitest';
import { validateTaskChannelFrame } from '../../src/ports/task-channel.js';
import {
  taskOutcomeAttachments,
  taskOutcomeFallback,
  taskOutcomeLanguage,
  taskOutcomeRedoFallback,
  validateTaskOutcome,
} from '../../src/ports/task-outcome.js';

describe('task outcome fallback', () => {
  it('counts missed changes without exposing raw command IDs, and distinguishes uncertainty', () => {
    const event = validateTaskOutcome({
      taskId: 'task-1',
      outcomeKey: 'outcome_task-1',
      state: 'failed',
      reasonCode: 'compute_missing',
      summary: 'Task disappeared.',
      objects: [],
      commands: [
        { commandId: 'private-command-id', kind: 'steer', delivery: 'not_delivered' },
        { commandId: 'crash-command-id', kind: 'steer', delivery: 'uncertain' },
      ],
    });
    const reply = taskOutcomeFallback(event);
    expect(reply).toContain('1 change did not reach my running work');
    expect(reply).toContain('may not have been applied');
    expect(reply).not.toContain('private-command-id');
    expect(reply).not.toContain('crash-command-id');
  });

  it.each(['constructor', 'unknown_failure'])(
    'uses the fixed generic explanation for allowed unknown reason code %s',
    (reasonCode) => {
      const summary = 'The task could not finish.';
      expect(
        validateTaskChannelFrame({
          taskId: 'task-1',
          attemptId: 'attempt-1',
          direction: 'task_to_core',
          messageId: 'message-1',
          sequence: 1,
          kind: 'terminal',
          payload: {
            outcome: 'failed',
            reasonCode,
            summary,
            resultObjectId: null,
            artifactObjectIds: [],
          },
        })
      ).toMatchObject({ payload: { reasonCode } });
      const outcome = validateTaskOutcome({
        taskId: 'task-1',
        outcomeKey: 'outcome_task-1',
        state: 'failed',
        reasonCode,
        summary,
        objects: [],
      });

      expect(taskOutcomeFallback(outcome)).toBe(
        'I could not complete the work. I could not confirm a more specific reason. How would you like me to proceed?'
      );
    }
  );
});

describe('verified work outcome metadata', () => {
  const base = {
    taskId: 'task-verify',
    outcomeKey: 'outcome_verify',
    state: 'failed',
    reasonCode: 'expected_outputs_missing',
    summary: 'Everything is done, there are 95 primes.',
    objects: [],
    expectedOutputs: ['primes500.txt'],
    missingExpectedOutputs: ['primes500.txt'],
    redoOf: 'task-original',
  };

  it('retains the expected names and redo link across outcome validation', () => {
    expect(validateTaskOutcome(base)).toMatchObject({
      expectedOutputs: ['primes500.txt'],
      missingExpectedOutputs: ['primes500.txt'],
      redoOf: 'task-original',
    });
  });

  it('reports only observed missing files, never a success claim from the summary', () => {
    const reply = taskOutcomeFallback(validateTaskOutcome(base));
    expect(reply).toContain('I did not receive the expected files: ["primes500.txt"]');
    expect(reply).toContain('How would you like me to proceed?');
    expect(reply).not.toContain('95 primes');
    expect(reply).not.toContain('Everything is done');
    expect(reply).not.toContain('the task');
  });

  it.each([
    { expectedOutputs: ['../outside.txt'] },
    { expectedOutputs: ['task-report.txt'] },
    { expectedOutputs: Array.from({ length: 17 }, (_, i) => `file${String(i)}.txt`) },
    { expectedOutputs: ['duplicate.txt', 'duplicate.txt'] },
    { missingExpectedOutputs: ['bad/name'] },
    { redoOf: '' },
  ])('refuses invalid verification metadata %j', (invalid) => {
    expect(() => validateTaskOutcome({ ...base, ...invalid })).toThrow();
  });
});

describe('task outcome attachments', () => {
  const result = {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'result.md',
    size: 42,
    sha256: 'a'.repeat(64),
    mark: 'result',
  };
  const artifact = {
    ...result,
    id: '22222222-2222-4222-8222-222222222222',
    name: 'budget chart.svg',
    mark: 'artifact',
    contentType: 'image/svg+xml',
  };
  const log = {
    ...result,
    id: '33333333-3333-4333-8333-333333333333',
    name: 'private.log',
    mark: 'log',
  };
  const event = {
    taskId: 'task-outputs',
    outcomeKey: 'outcome_outputs',
    state: 'done',
    reasonCode: 'completed',
    summary: 'Files ready.',
    objects: [artifact, log, result],
  };

  it('preserves sealed output order, plain names and MIME types without exposing logs', () => {
    expect(taskOutcomeAttachments(validateTaskOutcome(event))).toEqual([
      [
        {
          artifactId: artifact.id,
          name: 'budget chart.svg',
          size: 42,
          contentType: 'image/svg+xml',
        },
        {
          artifactId: result.id,
          name: 'result.md',
          size: 42,
          contentType: 'application/octet-stream',
        },
      ],
    ]);
  });

  it('does not treat artifact files as a substitute for the required completed result', () => {
    expect(() => validateTaskOutcome({ ...event, objects: [artifact, log] })).toThrow(
      'Task outcome missing result'
    );
  });

  it.each(['failed', 'stopped'])('does not attach retained outputs for %s', (state) => {
    expect(taskOutcomeAttachments(validateTaskOutcome({ ...event, state }))).toEqual([]);
  });
});

describe('owner language for deterministic outcome and redo replies', () => {
  const event = validateTaskOutcome({
    taskId: 'task-language',
    outcomeKey: 'outcome_language',
    state: 'failed',
    reasonCode: 'expected_outputs_missing',
    summary: 'UNTRUSTED-CLAIM',
    missingExpectedOutputs: ['result.txt'],
    expectedOutputs: ['result.txt'],
    objects: [
      { id: 'report', name: 'task-report.txt', size: 42, sha256: 'a'.repeat(64), mark: 'result' },
      { id: 'work', name: 'result.txt', size: 128, sha256: 'b'.repeat(64), mark: 'artifact' },
      { id: 'log', name: 'private.log', size: 99, sha256: 'c'.repeat(64), mark: 'log' },
    ],
    commands: [
      { commandId: 'private-1', kind: 'steer', delivery: 'not_delivered' },
      { commandId: 'private-2', kind: 'steer', delivery: 'not_delivered' },
      { commandId: 'private-3', kind: 'steer', delivery: 'uncertain' },
    ],
  });
  it.each([
    ['ru', 'Please check.', 'ru'],
    ['ru-RU', '', 'ru'],
    ['Russian', '', 'ru'],
    ['en', 'Проверь файл.', 'en'],
    ['en-GB', '', 'en'],
    [null, 'Проверь файл.', 'ru'],
    ['unknown', 'Проверь файл.', 'ru'],
    ['unknown', 'Please check.', 'en'],
    [null, '', 'en'],
    ['fr', '', 'en'],
  ] as const)('selects %s with owner text %j as %s', (preference, text, expected) => {
    expect(taskOutcomeLanguage(preference, text)).toBe(expected);
  });

  it.each(['ru', 'en'] as const)(
    'keeps observed facts and quoted changes identical in %s',
    (language) => {
      const reply = taskOutcomeFallback(
        event,
        new Map([
          ['private-1', 'Use range 1–700.'],
          ['private-2', 'Сохрани result.txt.'],
        ]),
        language,
        'female'
      );
      expect(reply).toContain('["result.txt"]');
      expect(reply).toContain('2');
      expect(reply).toContain('1');
      expect(reply).toContain('"Use range 1–700."');
      expect(reply).toContain('"Сохрани result.txt."');
      expect(reply).toContain(language === 'ru' ? 'не были применены' : 'were not applied');
      expect(reply).toContain(
        language === 'ru' ? 'могли не быть применены' : 'may not have been applied'
      );
      expect(reply).toContain(
        language === 'ru' ? 'Я не получила ожидаемые файлы' : 'I did not receive the expected files'
      );
      expect(reply).toContain(
        language === 'ru' ? 'Как мне продолжить?' : 'How would you like me to proceed?'
      );
      expect(reply).not.toMatch(/private-|UNTRUSTED-CLAIM|задач|остановилась|исполнитель/);

      const uncertain = taskOutcomeRedoFallback(event, true, language, 'female');
      expect(uncertain).toContain(
        language === 'ru'
          ? 'Если я начала исправленную попытку'
          : 'If I started a corrected attempt'
      );
      expect(uncertain).toContain(
        language === 'ru' ? 'не смогла подтвердить её состояние' : 'could not confirm its state'
      );
      expect(uncertain).toContain('"task-report.txt" (42');
      expect(uncertain).toContain('"result.txt" (128');
      expect(uncertain).not.toContain('private.log');
      const accepted = taskOutcomeRedoFallback(event, false, language, 'female');
      expect(accepted).toContain(
        language === 'ru'
          ? 'Я начала одну исправленную попытку и проверю её'
          : 'I have started one corrected attempt and will check it'
      );
      expect(accepted).not.toMatch(/задач|остановилась|исполнитель/);
    }
  );

  it.each([
    'completed',
    'timeout',
    'stopped',
    'aborted',
    'compute_missing',
    'job_failed',
    'semantic_report_missing',
    'missing_result',
    'expected_outputs_missing',
    'checksum_mismatch',
    'executor_failed',
    'launch_failed',
    'unknown',
    'constructor',
  ])('has a first-person Russian fallback for %s', (reasonCode) => {
    const reply = taskOutcomeFallback({ ...event, reasonCode, commands: [] }, new Map(), 'ru');
    expect(reply).toMatch(/^Я /);
    expect(reply).toContain('Как мне продолжить?');
    expect(reply).not.toMatch(/I could|I did|задач|остановилась|исполнитель/);
  });
});

describe('identity and output-name failure replies', () => {
  const event = validateTaskOutcome({
    taskId: 'task-identity',
    outcomeKey: 'outcome_identity',
    state: 'failed',
    reasonCode: 'completed',
    summary: 'UNTRUSTED-NAME invented.txt',
    objects: [],
    commands: [{ commandId: 'pending', kind: 'steer', delivery: 'uncertain' }],
  });
  it.each([
    ['female', 'Я получила файлы', 'не смогла', 'не подтвердила', 'Я начала', 'Если я начала'],
    ['male', 'Я получил файлы', 'не смог', 'не подтвердил', 'Я начал', 'Если я начал'],
    [
      'neutral',
      'Я располагаю файлами',
      'не могу',
      'не могу подтвердить',
      'Я выполняю',
      'Если исправленная попытка уже начата',
    ],
  ] as const)(
    'uses %s self-reference in ordinary and both redo replies',
    (gender, received, unable, pending, started, conditional) => {
      const reply = taskOutcomeFallback(event, new Map(), 'ru', gender);
      expect(reply).toContain(received);
      expect(reply).toContain(unable);
      expect(reply).toContain(pending);
      expect(taskOutcomeRedoFallback(event, false, 'ru', gender)).toContain(started);
      expect(taskOutcomeRedoFallback(event, true, 'ru', gender)).toContain(conditional);
      for (const reasonCode of [
        'completed',
        'stopped',
        'aborted',
        'compute_missing',
        'job_failed',
        'semantic_report_missing',
        'missing_result',
        'expected_outputs_missing',
        'checksum_mismatch',
        'executor_failed',
        'launch_failed',
        'unknown',
      ]) {
        const text = taskOutcomeFallback({ ...event, reasonCode }, new Map(), 'ru', gender);
        if (gender === 'neutral')
          expect(text).not.toMatch(/получил|смог|начала|прекратил|столкнул|подтвердил/);
        if (gender === 'male')
          expect(text).not.toMatch(/получила|смогла|начала|прекратила|столкнулась|подтвердила/);
      }
      expect(taskOutcomeFallback(event, new Map(), 'en', gender)).toContain('I received');
    }
  );
  it.each([
    { language: 'ru', gender: 'female', self: 'Я не смогла закончить выполнение' },
    { language: 'ru', gender: 'male', self: 'Я не смог закончить выполнение' },
    { language: 'ru', gender: 'neutral', self: 'Я не могу закончить выполнение' },
    { language: 'en', gender: 'neutral', self: 'I could not finish execution' },
  ] as const)(
    'explains the system-written report refusal in $language with $gender self-reference',
    ({ language, gender, self }) => {
      const reserved = taskOutcomeFallback(
        { ...event, reasonCode: 'output_name_reserved' },
        new Map(),
        language,
        gender
      );
      expect(reserved).toContain(self);
      expect(reserved).toMatch(
        language === 'ru'
          ? /моя запущенная работа попыталась записать файл с именем "task-report\.txt"/
          : /my running work tried to write a file named "task-report\.txt"/
      );
      expect(reserved).toMatch(
        language === 'ru'
          ? /система сама создаёт этот файл из итогового сообщения работы/
          : /system writes that file itself from the work's final message/
      );
      expect(reserved).toContain(
        language === 'ru' ? 'поэтому запуск отклонён' : 'so the run was refused'
      );
      expect(reserved).not.toMatch(/зарезервировано|reserved for my/);
      expect(reserved).not.toContain(event.summary);
      expect(reserved).not.toMatch(/UNTRUSTED|invented.txt/);
    }
  );

  it.each(['ru', 'en'] as const)(
    'explains ambiguous names in %s using metadata only',
    (language) => {
      const object = {
        id: 'a',
        name: 'same.txt',
        size: 1,
        sha256: 'a'.repeat(64),
        mark: 'artifact' as const,
      };
      const ambiguous = taskOutcomeFallback(
        {
          ...event,
          reasonCode: 'output_name_ambiguous',
          objects: [object, { ...object, id: 'b' }],
        },
        new Map(),
        language
      );
      expect(ambiguous).toContain('["same.txt"]');
      expect(ambiguous).toContain(
        language === 'ru' ? 'несколько файлов имеют одно имя' : 'multiple files have the same name'
      );
      const unnamed = taskOutcomeFallback(
        { ...event, reasonCode: 'output_name_ambiguous' },
        new Map(),
        language
      );
      expect(unnamed).toContain(
        language === 'ru' ? 'несколько файлов имеют одно имя' : 'multiple files have the same name'
      );
      expect(unnamed).not.toContain('same.txt');
      for (const text of [ambiguous, unnamed])
        expect(text).not.toMatch(/UNTRUSTED|invented.txt/);
    }
  );
});
