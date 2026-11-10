import { describe, expect, it, vi } from 'vitest';
import { getTraceContext } from '../../src/core/trace-context.js';
import { getPrimaryRecipientId } from '../../src/core/globals.js';
import { createSignal } from '../../src/types/signal.js';
import type { Logger } from '../../src/types/logger.js';
import {
  makeScratchDir,
  rmDir,
  startInstance,
  stopInstance,
  thoughtSignal,
  waitFor,
} from '../helpers/core-loop-drain-harness.js';

describe('completed turn effect conversation', () => {
  it.each([
    ['reply', 'signal'],
    ['thought', 'signal'],
    ['reply', 'tool'],
    ['thought', 'tool'],
  ] as const)(
    'keeps the settled %s recipient on a %s result effect, not tick effects',
    async (mode, traceKind) => {
      const lines: { message: string; conversationId?: string }[] = [];
      const record = (_obj: unknown, message?: string) => {
        const conversationId = getTraceContext()?.conversationId;
        lines.push({
          message: message ?? '',
          ...(conversationId === undefined ? {} : { conversationId }),
        });
      };
      const logger = {
        child: () => logger,
        debug: record,
        info: record,
        warn: record,
        error: record,
        trace: record,
      } as unknown as Logger;
      const scratch = await makeScratchDir('turn-effect-conversation-');
      const instance = await startInstance(scratch, {
        logger,
        sleepSchedule: { sleepHour: 0, wakeHour: 0 },
      });
      try {
        const signal =
          mode === 'reply'
            ? createSignal(
                'user_message',
                'sense.web',
                { value: 1 },
                {
                  data: {
                    kind: 'user_message',
                    text: 'hello',
                    channel: 'test',
                    recipientId: instance.recipientId,
                  },
                }
              )
            : thoughtSignal('a recipient-less thought');
        instance.cognition.result = {
          confidence: 1,
          intents: [
            {
              type: 'LOG',
              payload: { level: 'info', message: 'result effect' },
              trace:
                traceKind === 'signal'
                  ? { parentSignalId: signal.id }
                  : { toolCallId: 'tool-result' },
            },
          ],
          response: undefined,
        };
        const tick = instance.agent.tick.bind(instance.agent);
        vi.spyOn(instance.agent, 'tick').mockImplementation(() => [
          ...tick(),
          {
            type: 'LOG',
            payload: { level: 'info', message: 'tick effect' },
            trace: { tickId: 'housekeeping' },
          },
        ]);
        instance.coreLoop.pushSignal(signal);
        await waitFor(
          () => lines.some((line) => line.message === 'result effect'),
          'result effect applied'
        );
        const expected = mode === 'reply' ? instance.recipientId : getPrimaryRecipientId();
        expect(expected).toBeDefined();
        expect(lines.filter((line) => line.message === 'result effect')).toEqual([
          { message: 'result effect', conversationId: expected },
        ]);
        const ticks = lines.filter((line) => line.message === 'tick effect');
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.every((line) => line.conversationId === undefined)).toBe(true);
      } finally {
        await stopInstance(instance);
        await rmDir(scratch);
      }
    }
  );
});
