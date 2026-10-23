import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { applyCommittedOutboundEvents } from '../../src/core/message-streams.js';
import { ConversationManager } from '../../src/storage/conversation-manager.js';
import { PostgresConversationStore } from '../../src/storage/postgres-conversation-store.js';
import { PostgresTranscriptStore } from '../../src/storage/postgres-transcript-store.js';
import { SnapshotStore } from '../../src/storage/snapshot-store.js';
import type {
  AttachmentAuthorizer,
  MessageAttachment,
} from '../../src/ports/message-attachment.js';
import { createTestStores } from '../helpers/test-stores.js';
import { applyTestMigrations } from '../helpers/apply-test-migrations.js';
import { createTestLogger } from '../helpers/test-logger.js';

const file = (name = 'report.html'): MessageAttachment => ({
  artifactId: randomUUID(),
  name,
  size: 123,
  contentType: 'text/html',
});
const message = (attachments: MessageAttachment[]) => ({
  role: 'assistant',
  content: 'Your files',
  timestamp: new Date().toISOString(),
  attachments,
});

describe('persisted message attachments', () => {
  it('preserves metadata through snapshot, stream, Postgres replay and transcript reads', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const recipient = `attachment-outbound-${randomUUID()}`;
      const attachments = [file(), { ...file('empty.txt'), size: 0, contentType: 'text/plain' }];
      const snapshot = new SnapshotStore(stores.redis, { outboundKey: 'outbound' });
      const epoch = await snapshot.takeEpoch();
      const event = {
        eventId: randomUUID(),
        type: 'send.command',
        payload: { recipientId: recipient, channel: 'web', text: 'Your files', attachments },
      };
      await snapshot.commitOwners(epoch, 1, [event]);
      const writer = new PostgresConversationStore(stores.postgres);
      const conversations = new ConversationManager(writer, createTestLogger());
      expect(await applyCommittedOutboundEvents(stores.redis, conversations)).toBe(1);
      const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipient);
      const page = await transcript.readTranscript({ limit: 50 });
      expect(page.rows).toEqual([expect.objectContaining({ role: 'assistant', attachments })]);
      expect((await conversations.getFullHistory(recipient))[0]?.attachments).toEqual(attachments);
      for (const attachment of attachments) {
        const authorizer: AttachmentAuthorizer = transcript;
        expect(await authorizer.findAttachment(attachment.artifactId)).toEqual(attachment);
      }
      // Re-append the committed event after resetting the consumer cursor: the
      // physical message natural key still admits only one row.
      await stores.redis.set('outbound:pg-applied', '0-0');
      await stores.redis.xadd(
        'outbound',
        '*',
        'eventId',
        event.eventId,
        'event',
        JSON.stringify(event)
      );
      expect(await applyCommittedOutboundEvents(stores.redis, conversations)).toBe(1);
      expect((await transcript.readTranscript({ limit: 50 })).rows).toHaveLength(1);
      const persisted = await stores.postgres.query(
        'SELECT payload FROM core.conversation_messages WHERE recipient_id=$1',
        [recipient]
      );
      expect(persisted.rows[0]?.payload.attachments).toEqual(attachments);
      expect(Object.keys(persisted.rows[0]?.payload.attachments[0]).sort()).toEqual([
        'artifactId',
        'contentType',
        'name',
        'size',
      ]);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('preserves metadata in recent history when the assistant belongs to a user turn', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const recipient = `attachment-history-${randomUUID()}`;
      const attachments = [file()];
      const conversations = new ConversationManager(
        new PostgresConversationStore(stores.postgres),
        createTestLogger()
      );
      // Recent history is selected by user turns. An assistant-only fixture has
      // no turn start and is not returned by the existing history selector.
      await conversations.addMessage(recipient, { role: 'user', content: 'Make a report' });
      await conversations.addMessage(recipient, {
        role: 'assistant',
        content: 'Your files',
        attachments,
      });
      expect(await conversations.getHistory(recipient)).toEqual([
        expect.objectContaining({ role: 'user', content: 'Make a report' }),
        expect.objectContaining({ role: 'assistant', attachments }),
      ]);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('authorizes only committed visible assistant references for the bound recipient', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const recipient = `attachment-scope-${randomUUID()}`;
      const visible = file();
      const hidden = file();
      const other = file();
      const user = file();
      const tool = file();
      const system = file();
      const nullContent = file();
      const writer = new PostgresConversationStore(stores.postgres);
      const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipient);
      await writer.save(`conversation:${recipient}`, {
        messages: [
          message([visible]),
          { ...message([hidden]), tool_calls: [{ id: 'private-call' }] },
          { ...message([nullContent]), content: null },
        ],
      });
      await writer.save(`conversation:${recipient}-other`, { messages: [message([other])] });
      // Legacy/corrupt rows bypass the write validator. Authorization must not
      // infer permission from a matching UUID outside visible assistant rows.
      for (const [role, attachment] of [
        ['user', user],
        ['tool', tool],
        ['system', system],
      ] as const) {
        await stores.postgres.query(
          `INSERT INTO core.conversation_messages (recipient_id,message_id,kind,payload)
           VALUES ($1,$2,'message',$3::jsonb)`,
          [recipient, randomUUID(), JSON.stringify({ ...message([attachment]), role })]
        );
      }
      expect(await transcript.findAttachment(visible.artifactId)).toEqual(visible);
      for (const attachment of [hidden, other, user, tool, system, nullContent, file()]) {
        expect(await transcript.findAttachment(attachment.artifactId)).toBeNull();
      }
      expect(await transcript.findAttachment('../file')).toBeNull();
      // Clear/compaction change model context, not permanent owner-visible history.
      await writer.delete(`conversation:${recipient}`);
      expect(await transcript.findAttachment(visible.artifactId)).toEqual(visible);
      const rolledBack = file();
      const client = await stores.postgres.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO core.conversation_messages (recipient_id,message_id,kind,payload)
           VALUES ($1,$2,'message',$3::jsonb)`,
          [recipient, randomUUID(), JSON.stringify(message([rolledBack]))]
        );
        expect(await transcript.findAttachment(rolledBack.artifactId)).toBeNull();
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect(await transcript.findAttachment(rolledBack.artifactId)).toBeNull();
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('rejects malformed outbound attachments without advancing the consumer cursor', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const recipient = `attachment-invalid-${randomUUID()}`;
      const conversations = new ConversationManager(
        new PostgresConversationStore(stores.postgres),
        createTestLogger()
      );
      const event = {
        eventId: randomUUID(),
        type: 'send.command',
        payload: {
          recipientId: recipient,
          channel: 'web',
          text: 'Invalid file',
          attachments: [{ ...file(), size: -1 }],
        },
      };
      await stores.redis.xadd(
        'outbound',
        '*',
        'eventId',
        event.eventId,
        'event',
        JSON.stringify(event)
      );
      await expect(applyCommittedOutboundEvents(stores.redis, conversations)).rejects.toThrow(
        /attachment/i
      );
      expect(await stores.redis.get('outbound:pg-applied')).toBeNull();
      expect(
        (
          await new PostgresTranscriptStore(
            stores.postgres,
            stores.redis,
            recipient
          ).readTranscript({ limit: 50 })
        ).rows
      ).toEqual([]);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });

  it('fails closed when stored assistant attachment metadata is corrupt', async () => {
    const stores = await createTestStores();
    try {
      await applyTestMigrations(stores.postgres);
      const recipient = `attachment-corrupt-${randomUUID()}`;
      const attachment = { ...file(), url: 'https://untrusted.invalid/file' };
      await stores.postgres.query(
        `INSERT INTO core.conversation_messages (recipient_id,message_id,kind,payload)
         VALUES ($1,$2,'message',$3::jsonb)`,
        [recipient, randomUUID(), JSON.stringify(message([attachment]))]
      );
      const transcript = new PostgresTranscriptStore(stores.postgres, stores.redis, recipient);
      await expect(transcript.readTranscript({ limit: 50 })).rejects.toThrow(/attachment/i);
      await expect(transcript.findAttachment(attachment.artifactId)).rejects.toThrow(/attachment/i);
    } finally {
      await Promise.all([stores.postgres.end(), stores.redis.quit()]);
    }
  });
});
