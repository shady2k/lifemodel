// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import i18n from '../../web/app/src/i18n';
import { Conversation } from '../../web/app/src/Conversation';
import {
  MessageAttachments,
  formatAttachmentSize,
} from '../../web/app/src/components/MessageAttachments';
import { httpTransport, parseTranscriptMessage } from '../../web/app/src/transport';
import type { TranscriptMessage, WebTransport } from '../../web/app/src/transport';

const attachment = {
  artifactId: '0194c613-5200-7000-8000-000000000001',
  name: 'report.csv',
  size: 1500,
  contentType: 'text/csv',
};
const message: TranscriptMessage = {
  sequence: '1',
  role: 'assistant',
  text: 'Here is your report.',
  createdAt: '2026-10-23T12:30:00.000Z',
  attachments: [attachment],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('conversation file attachments', () => {
  it.each(['en', 'ru'])(
    'renders accessible theme-kit file links below text for transcript and live messages in %s',
    async (language) => {
      await i18n.changeLanguage(language);
      let receive: ((row: TranscriptMessage) => void) | undefined;
      const transport: WebTransport = {
        sendMessage: vi.fn().mockResolvedValue('accepted'),
        readTranscript: vi.fn().mockResolvedValue({ messages: [message], cursor: '1' }),
        onSessionExpired: () => () => undefined,
        subscribe: (_after, onMessage) => {
          receive = onMessage;
          return () => undefined;
        },
      };
      render(<Conversation transport={transport} />);
      const link = await screen.findByRole('link', {
        name: i18n.t('downloadAttachment', {
          name: attachment.name,
          size: formatAttachmentSize(attachment.size, language),
        }),
      });
      expect(link.getAttribute('href')).toBe(`/api/attachments/${attachment.artifactId}`);
      expect(link.getAttribute('download')).toBe('report.csv');
      expect(link.getAttribute('data-slot')).toBe('button');
      expect(link.querySelector('svg')).not.toBeNull();
      expect(link.textContent).toContain('report.csv');
      expect(link.textContent).toContain(formatAttachmentSize(1500, language));
      const text = screen.getByText(message.text);
      expect(text.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByRole('list', { name: i18n.t('attachments') })).toBeTruthy();
      await waitFor(() => expect(receive).toBeTypeOf('function'));
      act(() => {
        receive?.({
          ...message,
          sequence: '2',
          text: 'One more file.',
          attachments: [{ ...attachment, artifactId: 'second-file', name: 'notes.txt', size: 0 }],
        });
      });
      const live = await screen.findByRole('link', {
        name: i18n.t('downloadAttachment', {
          name: 'notes.txt',
          size: formatAttachmentSize(0, language),
        }),
      });
      expect(live.getAttribute('href')).toBe('/api/attachments/second-file');
    }
  );

  it('renders no file list for messages without attachments', async () => {
    await i18n.changeLanguage('en');
    const { container } = render(<MessageAttachments attachments={undefined} />);
    expect(container.childElementCount).toBe(0);
  });

  it('keeps filenames inert and artifact ids in a same-origin path segment', async () => {
    await i18n.changeLanguage('en');
    const name = '<img src=x onerror=alert(1)>.html';
    const artifactId = 'https://untrusted.example/file?value=1#fragment';
    const { container } = render(
      <MessageAttachments attachments={[{ ...attachment, artifactId, name }]} />
    );
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe(`/api/attachments/${encodeURIComponent(artifactId)}`);
    expect(link.getAttribute('download')).toBe(name);
    expect(link.getAttribute('target')).toBeNull();
    expect(screen.getByText(name)).toBeTruthy();
    expect(container.querySelector('img, [onerror]')).toBeNull();
  });

  it.each([
    ['en', ['0 B', '66 B', '999 B', '1.5 kB', '2.5 MB', '1 GB']],
    ['ru', ['0 Б', '66 Б', '999 Б', '1,5 кБ', '2,5 МБ', '1 ГБ']],
  ])(
    'formats short byte units and larger files in %s without excessive precision',
    (language, sizes) => {
      const values = [0, 66, 999, 1500, 2_500_000, 1_000_000_000];
      expect(values.map((size) => formatAttachmentSize(size, language))).toEqual(sizes);
    }
  );

  it('preserves attachment metadata in the live-message parser and HTTP page reader', async () => {
    expect(parseTranscriptMessage(message)).toEqual(message);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ messages: [message], cursor: '1' }), { status: 200 })
        )
    );
    expect(await httpTransport.readTranscript()).toEqual({ messages: [message], cursor: '1' });
  });

  it.each([
    null,
    {},
    [null],
    [{ ...attachment, artifactId: '' }],
    [{ ...attachment, size: -1 }],
    [{ ...attachment, size: 1.5 }],
    [{ ...attachment, size: Number.POSITIVE_INFINITY }],
    [{ ...attachment, contentType: null }],
    [{ ...attachment, name: 7 }],
  ])('rejects malformed attachment metadata: %j', (attachments) => {
    expect(() => parseTranscriptMessage({ ...message, attachments })).toThrow(
      'Transcript attachments have an invalid shape'
    );
  });
});
