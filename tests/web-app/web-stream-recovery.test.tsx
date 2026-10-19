// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import 'jest-axe/extend-expect';
import i18n from '../../web/app/src/i18n';
import { Conversation } from '../../web/app/src/Conversation';
import { httpTransport } from '../../web/app/src/transport';
import { createWebServer } from '../../src/web/server.js';
import { silentModelStatus } from '../helpers/model-status.js';
import { installBrowserFetch, waitUntil } from '../helpers/browser-event-source.js';
import type {
  ReadTranscriptOptions,
  TranscriptPage,
  TranscriptReader,
  TranscriptRow,
} from '../../src/ports/transcript.js';

/**
 * The transcript port behind the real web server, in memory: rows appear when
 * a test appends them, and the stream slots can be refused the way four leases
 * of a dead web module refuse the owner's first stream.
 */
class MemoryTranscript implements TranscriptReader {
  readonly rows: TranscriptRow[] = [];
  refused = false;
  private leases = 0;

  append(role: 'user' | 'assistant', text: string): TranscriptRow {
    const row: TranscriptRow = {
      sequence: String(this.rows.length + 1),
      role,
      text,
      createdAt: new Date().toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async readTranscript(options: ReadTranscriptOptions): Promise<TranscriptPage> {
    const cursor = options.after ?? options.before;
    const matching = this.rows.filter((row) =>
      options.after !== undefined
        ? BigInt(row.sequence) > BigInt(options.after)
        : cursor === undefined
          ? true
          : BigInt(row.sequence) < BigInt(cursor)
    );
    const rows =
      options.after === undefined
        ? matching.slice(-options.limit).reverse()
        : matching.slice(0, options.limit);
    return { rows, cursor: this.rows.at(-1)?.sequence ?? null };
  }

  async *watchTranscript(after: string, signal?: AbortSignal): AsyncIterable<TranscriptRow> {
    let cursor = after;
    while (!signal?.aborted) {
      const next = this.rows.filter((row) => BigInt(row.sequence) > BigInt(cursor));
      for (const row of next) {
        cursor = row.sequence;
        yield row;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async acquireStreamLease(_session: string, _expiresAt: number): Promise<string | null> {
    if (this.refused) return null;
    this.leases += 1;
    return `lease-${String(this.leases)}`;
  }

  async renewStreamLease(): Promise<boolean> {
    return true;
  }

  async releaseStreamLease(): Promise<void> {
    return undefined;
  }
}

afterEach(() => {
  cleanup();
});

describe('the open page and its event stream', () => {
  it('shows the reply without a reload after the stream was refused, in both languages', async () => {
    const transcript = new MemoryTranscript();
    transcript.refused = true;
    transcript.append('user', 'привет');
    const server = createWebServer({
      allowedOrigin: 'https://lifemodel.local',
      instanceName: 'lifemodel',
      appDirectory: new URL('../fixtures/web-app/', import.meta.url).pathname,
      runtimeMetrics: { intakeFailures: 0, sseLag: 0, reconnects: 0 },
      intake: {
        acceptOwnerMessage: async () => ({ status: 'accepted', streamId: '1-0' }),
      } as never,
      transcript,
      creatureState: { readCreatureState: async () => null },
      modelStatus: silentModelStatus(),
      logger: { info: () => undefined },
    });
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address();
    if (!address || typeof address === 'string') throw new Error('the test server has no address');
    const browser = installBrowserFetch(`http://127.0.0.1:${address.port}`);
    try {
      await i18n.changeLanguage('en');
      const { container } = render(<Conversation transport={httpTransport} />);
      await screen.findByText('привет');
      await waitUntil(
        () => browser.sources().some((source) => source.lastStatus === 429),
        'the first stream to be refused'
      );
      // The reply is committed while the page has no stream at all.
      transcript.append('assistant', 'ответ');
      await screen.findByText('ответ', {}, { timeout: 15_000 });
      expect(screen.getByTestId('live-announcement').textContent).toBe(
        'New message from lifemodel.'
      );
      transcript.refused = false;
      transcript.append('assistant', 'второй ответ');
      await screen.findByText('второй ответ', {}, { timeout: 15_000 });
      expect(screen.getAllByText('ответ')).toHaveLength(1);
      expect(await axe(container)).toHaveNoViolations();
      await i18n.changeLanguage('ru');
      await waitFor(() => expect(screen.getByPlaceholderText('Написать сообщение…')).toBeTruthy());
      expect(await axe(container)).toHaveNoViolations();
    } finally {
      browser.restore();
      await server.server.closeAllConnections?.();
      await server.close();
    }
  }, 120_000);
});
