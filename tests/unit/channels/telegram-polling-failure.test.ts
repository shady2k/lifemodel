/**
 * A Telegram channel that cannot poll must not end the process
 * (lifemodel-q4x.4.1).
 *
 * Found by the gated Docker walk: after the settings page saved the Agent Vault
 * placeholder as the bot token, the next start handed that token to grammy,
 * `getMe` was refused, `bot.start()` rejected, the rejection was unhandled and
 * lifemodel left with code 1 - so the loader restarted it, it failed again, and
 * the instance crash-looped with its settings page unreachable.
 *
 * The rule: the failure is logged at error with its cause, and the agent keeps
 * running without the Telegram channel.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TelegramChannel, type TelegramConfig } from '../../../src/plugins/channels/telegram.js';
import type { IRecipientRegistry } from '../../../src/core/recipient-registry.js';

/** A bot whose polling is refused, the way the API refuses a bad token. */
const refusal = { error: new Error('401: Unauthorized') };

vi.mock('grammy', () => {
  class MockBot {
    on = vi.fn();
    catch = vi.fn();
    start = vi.fn().mockImplementation(() => Promise.reject(refusal.error));
    stop = vi.fn().mockResolvedValue(undefined);
    api = { sendMessage: vi.fn(), sendChatAction: vi.fn() };
  }
  return { Bot: MockBot };
});

function createMockLogger() {
  const mock = {
    child: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  };
  mock.child.mockReturnValue(mock);
  return mock;
}

const registry = {
  getOrCreate: vi.fn().mockReturnValue('rcpt_1'),
  resolve: vi.fn().mockReturnValue(null),
  lookup: vi.fn().mockReturnValue(null),
  getRecord: vi.fn().mockReturnValue(null),
  touch: vi.fn(),
  getAll: vi.fn().mockReturnValue([]),
  size: vi.fn().mockReturnValue(0),
} as unknown as IRecipientRegistry;

const config: TelegramConfig = {
  botToken: '__telegram_bot_token__',
  timeout: 5000,
  maxRetries: 3,
  retryDelay: 100,
};

describe('a Telegram channel that cannot poll (lifemodel-q4x.4.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('logs the cause and leaves the agent running, instead of an unhandled rejection', async () => {
    const logger = createMockLogger();
    const channel = new TelegramChannel(config, logger as never, registry);

    // No rejection escapes: this is what used to end the process.
    await expect(channel.start()).resolves.toBeUndefined();
    // The polling failure is reported once, with the reason.
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(
      { error: '401: Unauthorized' },
      expect.stringContaining('runs without the Telegram channel')
    );
    // And the channel does not claim to be running: a stop that follows does
    // not wait on polling that never began.
    expect((channel as unknown as { running: boolean }).running).toBe(false);
  });
});
