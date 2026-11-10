/**
 * The core's turn lines carry `conversation_id`, as that exact name, and the
 * collector stores it (ADR-016 §2 and §9 point 4, check L02).
 *
 * The lines are the core's own, written by the pino logger `createLogger`
 * builds, during a REAL turn: the real CoreLoop, the real cognition processor
 * and the real agentic loop, with only the LLM provider scripted
 * (`tests/fixtures/logs-vrl/turn-record-lines.ts`). One turn is a reply, which
 * carries its own recipient; the other is a `thought`, which carries none and
 * must log under cognition's fallback, the primary recipient - the rule
 * `CognitionProcessor.process` uses, read from the same function.
 *
 * The collector's half needs the pinned VRL binary, and the isolated test
 * boundary has neither it nor a Docker socket (the test container is attached
 * to no network and mounts no socket), so it cannot run here. The same case
 * list is run through the real remap program on the host by
 * `scripts/check-logs-vrl.mjs`:
 *
 *   flock /work/check.lock node scripts/check-logs-vrl.mjs
 *
 * Nothing here stands in for the VRL: without a runner the collector test says
 * so and is skipped, and every assertion the lines themselves can carry is
 * made here.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import {
  recordShapeCases,
  runVrlCases,
  tickLine,
  turnLines,
  turnRecordRuns,
} from '../../scripts/logs-record-shape.mjs';
import { vectorRunner } from '../../scripts/logs-vector-runner.mjs';
import collectorFixtures from '../fixtures/logs-vrl/cases.json';

interface LogLine {
  level: number;
  msg: string;
  traceId?: string;
  spanId?: string;
  conversation_id?: string;
  conversationId?: string;
  module?: string;
  recipientId?: string;
}

interface TurnRun {
  /** The conversation the turn ran for, as the fixture read it. */
  result: {
    triggerType: string;
    triggerSignalId: string;
    conversationId: string;
    primaryRecipientId: string;
  };
  lines: LogLine[];
}

const MODES = ['reply', 'thought'] as const;
type Mode = (typeof MODES)[number];

let runs: { levels: LogLine[] } & Record<Mode, TurnRun>;

/** The pinned VRL, or undefined: the boundary has no way to run it. */
const runner = vectorRunner();

beforeAll(() => {
  runs = turnRecordRuns() as typeof runs;
}, 180_000);

describe('a turn logs under the conversation it runs for (ADR-016 §9 point 4)', () => {
  it.each(MODES)('every line the %s turn writes carries it, and no other line does', (mode) => {
    const run = runs[mode];
    const turn = turnLines(run);
    // The turn's own work: its model call, the loop around it, and its outcome.
    for (const message of [
      'Agentic loop starting',
      'LLM completion with tools done',
      'Agentic loop complete',
      '🔄 Agent turn complete',
    ]) {
      expect(turn.map((line) => line.msg)).toContain(message);
    }
    for (const line of turn) {
      expect(line.conversation_id).toBe(run.result.conversationId);
      // The turn's trace is the trigger's, so the id sits where the turn's
      // recipient is settled, not on a separate line.
      expect(line.traceId).toBe(run.result.triggerSignalId);
    }
    // Immediate tool effects create their own spans, but remain in the turn's
    // conversation. Assert the actual effect line, not just the loop around it.
    const effects = run.lines.filter((line) => line.msg === 'Memory stored');
    expect(effects).toHaveLength(1);
    for (const line of effects) {
      expect(line.traceId).toBe(run.result.triggerSignalId);
      expect(line.conversation_id).toBe(run.result.conversationId);
    }
    const turnLinesSet = new Set([...turn, ...effects]);
    for (const line of run.lines.filter((candidate) => !turnLinesSet.has(candidate))) {
      expect(line.conversation_id).toBeUndefined();
    }
  });

  it('a reply turn logs under its own recipient', () => {
    const run = runs.reply;
    const outcome = turnLines(run).find((line) => line.msg === '🔄 Agent turn complete');
    expect(outcome?.conversation_id).toBe(run.result.conversationId);
    // A reply's recipient is its own; the fallback is a different one, so the
    // two rules cannot be confused here.
    expect(run.result.conversationId).not.toBe(run.result.primaryRecipientId);
    // The reply's recipient is the one cognition logs for the turn.
    expect(outcome?.recipientId).toBe(run.result.conversationId);
  });

  it('a recipient-less thought logs under the primary recipient, the rule cognition uses', () => {
    const run = runs.thought;
    const outcome = turnLines(run).find((line) => line.msg === '🔄 Agent turn complete');
    expect(run.result.conversationId).toBe(run.result.primaryRecipientId);
    expect(outcome?.recipientId).toBe(run.result.primaryRecipientId);
    expect(outcome?.conversation_id).toBe(run.result.primaryRecipientId);
  });

  it('a tick-level line carries none', () => {
    for (const mode of MODES) {
      expect(tickLine(runs[mode]).conversation_id).toBeUndefined();
    }
  });

  it('the key is snake_case, and no line claims a module', () => {
    for (const line of [...runs.reply.lines, ...runs.thought.lines, ...runs.levels]) {
      // A camelCase key produces no `conversation_id` in the collector
      // (measured, ADR-016 §9 point 4).
      expect(line.conversationId).toBeUndefined();
      // The module is the pod's label, never the line (§2).
      expect(line.module).toBeUndefined();
    }
  });

  it('the logger writes one JSON record per level, and none carries a conversation', () => {
    expect(runs.levels.map((line) => line.level)).toEqual([10, 20, 30, 40, 50, 60]);
    for (const line of runs.levels) expect(line.conversation_id).toBeUndefined();
  });
});

describe('the collector stores the record contract (L02, real VRL)', () => {
  it('builds the cases from the real lines and the contract fixtures', () => {
    const cases = [...collectorFixtures.cases, ...recordShapeCases(runs)];
    const names = cases.map((testCase: { name: string }) => testCase.name);
    // L02's fixtures: both turns, every pino level, the level words including
    // `err`, a coloured pretty line, a malformed JSON line, a line with no
    // level, a forged module/level, and a `lifemodel-motor` line.
    for (const name of [
      'turn-reply-tick-line',
      'turn-thought-tick-line',
      'pino-level-0',
      'pino-level-5',
      'text-error-err',
      'coloured-pretty-line',
      'malformed-json',
      'no-level',
      'forged-module',
      'task-line-promotes-nothing',
    ]) {
      expect(names).toContain(name);
    }
  });

  it.skipIf(runner === undefined)(
    'the real VRL stores conversation_id, module, level, stream, untrusted and the promoted failure fields',
    () => {
      const cases = [...collectorFixtures.cases, ...recordShapeCases(runs)];
      const outcome = runVrlCases(cases, runner);
      expect(outcome.cases).toBe(cases.length);
      expect(outcome.output).toContain('... passed');
      expect(outcome.ok, outcome.output).toBe(true);
    },
    300_000
  );
});

if (runner === undefined) {
  console.info(
    'L02: the collector VRL half is skipped here. The isolated test boundary mounts no Docker ' +
      'socket and attaches the test container to no network, so neither the pinned Vector image ' +
      'nor a vector binary can run in it. scripts/check-logs-vrl.mjs runs this same case list ' +
      'through the committed remap program on the host.'
  );
}
