import { describe, expect, it, vi } from 'vitest';
import {
  isArtifactId,
  validateMessageAttachments,
  type MessageAttachment,
} from '../../src/ports/message-attachment.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { IntentApplicator, type IntentApplicatorDeps } from '../../src/core/intent-applicator.js';
import type { SnapshotOutboxEvent } from '../../src/storage/snapshot-store.js';
import type { SendMessageIntent } from '../../src/types/intent.js';

const attachment: MessageAttachment = {
  artifactId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  name: 'report.html',
  size: 0,
  contentType: 'text/html',
};

function applicator(enqueueOutbound: (event: SnapshotOutboxEvent) => void): IntentApplicator {
  return new IntentApplicator({
    recipientRegistry: { resolve: () => ({ channel: 'web', destination: 'owner' }) },
    metrics: { counter: vi.fn() },
    enqueueOutbound,
  } as unknown as IntentApplicatorDeps);
}

describe('message attachment metadata', () => {
  it('keeps metadata only, normalizes object UUIDs, and makes an independent copy', () => {
    const input = [{ ...attachment, artifactId: attachment.artifactId.toUpperCase() }];
    expect(isArtifactId(input[0]!.artifactId)).toBe(true);
    const result = validateMessageAttachments(input, 'assistant');
    expect(result).toEqual([attachment]);
    expect(result).not.toBe(input);
    expect(result?.[0]).not.toBe(input[0]);
    expect(validateMessageAttachments(undefined, 'user')).toBeUndefined();
    expect(validateMessageAttachments([], 'assistant')).toEqual([]);
    expect(
      validateMessageAttachments([{ ...attachment, size: Number.MAX_SAFE_INTEGER }], 'assistant')
    ).toEqual([{ ...attachment, size: Number.MAX_SAFE_INTEGER }]);
  });

  it.each(
    [
      null,
      {},
      [null],
      [{ ...attachment, artifactId: '../report' }],
      [{ ...attachment, artifactId: 'https://storage.example/report' }],
      [{ ...attachment, artifactId: 'task-653' }],
      [{ ...attachment, artifactId: `${attachment.artifactId}\n` }],
      [{ ...attachment, name: '' }],
      [{ ...attachment, name: 123 }],
      [{ ...attachment, contentType: '' }],
      [{ ...attachment, contentType: null }],
      [{ ...attachment, size: -1 }],
      [{ ...attachment, size: 0.5 }],
      [{ ...attachment, size: Number.MAX_SAFE_INTEGER + 1 }],
      [{ ...attachment, size: NaN }],
      [{ ...attachment, size: Infinity }],
      [{ ...attachment, size: '100' }],
      Array(1),
      [{ ...attachment, url: 'https://storage.example/report' }],
      [{ ...attachment, bytes: [1, 2, 3] }],
    ].map((value) => ({ value }))
  )('rejects malformed or non-metadata fields: $value', ({ value }) => {
    expect(() => validateMessageAttachments(value, 'assistant')).toThrow(/attachment/i);
  });

  it('accepts the attachment count, UTF-8 byte and MIME length boundaries', () => {
    const bounded = {
      ...attachment,
      name: '😀'.repeat(256),
      contentType: `application/${'a'.repeat(116)}`,
    };
    const attachments = Array.from({ length: 20 }, () => ({ ...bounded }));
    expect(validateMessageAttachments(attachments, 'assistant')).toEqual(attachments);
    expect(
      validateMessageAttachments([{ ...attachment, name: 'a'.repeat(1024) }], 'assistant')
    ).toEqual([{ ...attachment, name: 'a'.repeat(1024) }]);
  });

  it('keeps valid Unicode, quotes and CRLF in display names for safe response escaping', () => {
    const named = { ...attachment, name: 'résumé "report"\r\n😀.html' };
    expect(validateMessageAttachments([named], 'assistant')).toEqual([named]);
    expect(() =>
      encodeURIComponent(validateMessageAttachments([named], 'assistant')![0]!.name)
    ).not.toThrow();
  });

  it.each([
    ['too many attachments', Array.from({ length: 21 }, () => ({ ...attachment }))],
    ['ASCII name beyond byte limit', [{ ...attachment, name: 'a'.repeat(1025) }]],
    ['Unicode name beyond byte limit', [{ ...attachment, name: '😀'.repeat(256) + 'a' }]],
    ['lone high surrogate', [{ ...attachment, name: '\ud800' }]],
    ['lone low surrogate', [{ ...attachment, name: 'report\udfff.txt' }]],
    ['unpaired surrogate between valid text', [{ ...attachment, name: 'a\ud800b' }]],
    [
      'MIME beyond character limit',
      [{ ...attachment, contentType: `application/${'a'.repeat(117)}` }],
    ],
    ['MIME without subtype', [{ ...attachment, contentType: 'text' }]],
    ['MIME with empty type', [{ ...attachment, contentType: '/plain' }]],
    ['MIME with extra slash', [{ ...attachment, contentType: 'text/plain/html' }]],
    ['MIME with whitespace', [{ ...attachment, contentType: 'text/ plain' }]],
    ['MIME with parameters', [{ ...attachment, contentType: 'text/plain; charset=utf-8' }]],
    ['MIME wildcard', [{ ...attachment, contentType: 'text/*' }]],
    ['MIME CRLF', [{ ...attachment, contentType: 'text/plain\r\nX-Injected: value' }]],
    ['MIME Unicode', [{ ...attachment, contentType: 'text/é' }]],
    ['MIME trailing newline', [{ ...attachment, contentType: 'text/plain\n' }]],
  ])('rejects bounded metadata violation: %s', (_reason, value) => {
    expect(() => validateMessageAttachments(value, 'assistant')).toThrow(/attachment/i);
  });

  it.each(['user', 'tool', 'system'])('rejects attachments on %s messages', (role) => {
    expect(() => validateMessageAttachments([attachment], role)).toThrow(/assistant/i);
    expect(() => validateMessageAttachments([], role)).toThrow(/assistant/i);
  });

  it('rejects invalid writes before any database access', async () => {
    const connect = vi.fn();
    const writer = new PostgresConversationStore({ connect } as unknown as import('pg').Pool);
    await expect(
      writer.save('conversation:owner', {
        messages: [{ role: 'user', content: 'x', attachments: [attachment] }],
      })
    ).rejects.toThrow(/assistant/i);
    await expect(
      writer.save('conversation:owner', {
        messages: [{ role: 'assistant', content: 'x', attachments: [{ ...attachment, size: -1 }] }],
      })
    ).rejects.toThrow(/attachment/i);
    expect(connect).not.toHaveBeenCalled();
  });

  it('passes attachment metadata from a SEND_MESSAGE intent into its durable outbox', () => {
    const enqueue = vi.fn();
    const input = [{ ...attachment, artifactId: attachment.artifactId.toUpperCase() }];
    applicator(enqueue).apply(
      [
        {
          type: 'SEND_MESSAGE',
          payload: { recipientId: 'owner', text: 'Your file', attachments: input },
        },
      ],
      { traceId: 'attachment-intent' }
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'send.command',
        payload: expect.objectContaining({ recipientId: 'owner', attachments: [attachment] }),
      })
    );
    input[0]!.name = 'changed';
    expect(enqueue.mock.calls[0]?.[0].payload.attachments).toEqual([attachment]);
  });

  it('does not enqueue malformed attachment metadata', () => {
    const enqueue = vi.fn();
    const intent = {
      type: 'SEND_MESSAGE',
      payload: {
        recipientId: 'owner',
        text: 'Your file',
        attachments: [{ ...attachment, url: 'x' }],
      },
    } as SendMessageIntent;
    expect(() => applicator(enqueue).apply([intent], { traceId: 'bad-attachment-intent' })).toThrow(
      /attachment/i
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
