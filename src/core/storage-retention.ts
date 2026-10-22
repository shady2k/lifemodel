import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { SnapshotStore, SnapshotOutboxEvent } from '../storage/snapshot-store.js';
import type { PostgresConversationStore } from '../storage/postgres-conversation-store.js';
import type { ConversationManager } from '../storage/conversation-manager.js';
import {
  StorageControlError,
  type StorageControlClient,
  type DeletionPlan,
} from './storage-control-client.js';
import type { RecipientRoute } from './recipient-registry.js';

/** Module IDs accept only letters, digits, dash and underscore (no colon). */
export function storageWarningEventId(planId: string): string {
  return `storage-warning_${createHash('sha256').update(planId).digest('hex')}`;
}

function notice(plan: DeletionPlan, language: string | null): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  const index =
    plan.totalBytes === 0 ? 0 : Math.min(4, Math.floor(Math.log10(plan.totalBytes) / 3));
  const bytes = `${String(Number((plan.totalBytes / 1000 ** index).toFixed(2)))} ${units[index] ?? 'B'}`;
  const days = String(plan.leadDays);
  const translations: Record<string, string> = {
    en: `${bytes} of old task output is scheduled for deletion no earlier than ${days} days from now. Nothing will be deleted before then.`,
    ru: `${bytes} старых результатов задач запланировано к удалению не ранее чем через ${days} дней. До этого срока ничего не будет удалено.`,
    es: `${bytes} de resultados antiguos de tareas se eliminarán no antes de ${days} días a partir de ahora. No se eliminará nada antes de ese plazo.`,
    de: `${bytes} alter Aufgabenergebnisse werden frühestens in ${days} Tagen gelöscht. Vorher wird nichts gelöscht.`,
    fr: `${bytes} d’anciens résultats de tâches seront supprimés au plus tôt dans ${days} jours. Rien ne sera supprimé avant ce délai.`,
    zh: `${bytes} 的旧任务输出计划在至少 ${days} 天后删除。在此之前不会删除任何内容。`,
    ja: `${bytes} の古いタスク出力は、今から少なくとも ${days} 日後に削除される予定です。それまでは何も削除されません。`,
  };
  const aliases: Record<string, string> = {
    english: 'en',
    russian: 'ru',
    русский: 'ru',
    spanish: 'es',
    german: 'de',
    french: 'fr',
    chinese: 'zh',
    japanese: 'ja',
  };
  const preference = (language ?? 'en').toLowerCase().split(/[-_]/)[0] ?? 'en';
  const key = aliases[preference] ?? preference;
  // No promise of a comprehensible warning in an unsupported language: leave
  // the plan pending instead of silently authorizing deletion in English.
  const text = translations[key];
  if (!text) throw new StorageControlError('/retention/notice-language');
  return text;
}

/** A bounded infrastructure contract, not agent cognition. One page per pass;
 * cursor advances only across successful pages and resets after the last page.
 * Failures retry the same page, with durable plan receipts suppressing duplicates.
 */
export function createStorageRetentionReconciler(options: {
  client: StorageControlClient;
  snapshotStore: SnapshotStore;
  epoch: number;
  conversations: ConversationManager;
  conversationStore: Pick<PostgresConversationStore, 'findChannelMessage'>;
  recipientId: string;
  route: RecipientRoute;
  language: () => string | null;
  logger: Logger;
  intervalMs?: number;
  retryMs?: number;
}) {
  const intervalMs = options.intervalMs ?? 5 * 60_000;
  const retryMs = options.retryMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let started = false;
  let inflight: Promise<boolean> | undefined;
  let cursor: string | undefined;
  let failures = 0;
  const controller = new AbortController();
  const logFailure = (error: unknown, planId?: string) => {
    const failure =
      error instanceof StorageControlError
        ? error
        : new StorageControlError('/retention/reconcile');
    options.logger.warn(
      {
        id: failure.id,
        route: failure.route,
        ...(planId ? { planId } : {}),
        ...(failure.status === undefined ? {} : { status: failure.status }),
        count: 1,
      },
      'Storage warning remains pending'
    );
  };
  async function pass(): Promise<boolean> {
    if (stopped) return false;
    let page;
    try {
      page = await options.client.plans(cursor, controller.signal);
    } catch (error) {
      if (!stopped) logFailure(error);
      return false;
    }
    let success = true;
    const attempted = new Set<string>();
    const confirm = async (planId: string, event: SnapshotOutboxEvent): Promise<void> => {
      const payload = event.payload as { recipientId: string; channel: string; text: string };
      if (
        event.eventId !== storageWarningEventId(planId) ||
        event.type !== 'send.command' ||
        payload.recipientId !== options.recipientId ||
        payload.channel !== 'web' ||
        typeof payload.text !== 'string'
      )
        throw new StorageControlError('/retention/receipt');
      if (stopped) throw new StorageControlError('/retention/stopped');
      await options.conversations.addMessage(
        payload.recipientId,
        { role: 'assistant', content: payload.text },
        { channel: payload.channel, channelMessageId: event.eventId }
      );
      if (stopped) throw new StorageControlError('/retention/stopped');
      try {
        await options.client.warningCommitted(planId, event.eventId, controller.signal);
      } catch (error) {
        if (!(error instanceof StorageControlError) || error.status !== 409) throw error;
        // Another message is already recorded. Never invent a new notice.
        logFailure(error, planId);
      }
      if (stopped) throw new StorageControlError('/retention/stopped');
      // Never discard the append-to-projection recovery payload without a fresh
      // physical-row read. A read failure retains hot work for a later pass.
      const persisted = await options.conversationStore.findChannelMessage(
        payload.recipientId,
        payload.channel,
        event.eventId
      );
      if (!persisted) throw new StorageControlError('/retention/projection');
      if (stopped) throw new StorageControlError('/retention/stopped');
      await options.snapshotStore.releaseNotice(options.epoch, event.eventId);
    };
    try {
      for (const event of await options.snapshotStore.pendingNotices()) {
        if (stopped) return false;
        const planId = event.payload['storageDeletionPlanId'];
        if (typeof planId !== 'string') throw new StorageControlError('/retention/receipt');
        attempted.add(planId);
        try {
          await confirm(
            planId,
            await options.snapshotStore.commitNotice(options.epoch, event, true)
          );
        } catch (error) {
          success = false;
          if (!stopped) logFailure(error, planId);
        }
      }
    } catch (error) {
      if (!stopped) logFailure(error);
      return false;
    }
    for (const plan of page.plans) {
      if (stopped) return false;
      if (attempted.has(plan.id)) continue;
      try {
        const eventId = storageWarningEventId(plan.id);
        // Fail closed on a historical lookup error. A physical Postgres row is
        // permanent even when clear/compaction hides it from current history.
        const persisted = await options.conversationStore.findChannelMessage(
          options.recipientId,
          options.route.channel,
          eventId
        );
        if (stopped) return false;
        const event = await options.snapshotStore.commitNotice(
          options.epoch,
          {
            eventId,
            type: 'send.command',
            payload: {
              recipientId: options.recipientId,
              ...options.route,
              text: persisted?.content ?? notice(plan, options.language()),
              storageDeletionPlanId: plan.id,
            },
          },
          persisted !== null
        );
        await confirm(plan.id, event);
      } catch (error) {
        success = false;
        if (!stopped) logFailure(error, plan.id);
      }
    }
    if (success) cursor = page.nextCursor ?? undefined;
    return success;
  }
  function runOnce(): Promise<boolean> {
    if (stopped) return Promise.resolve(false);
    if (inflight) return inflight;
    inflight = pass().finally(() => {
      inflight = undefined;
    });
    return inflight;
  }
  function schedule() {
    void runOnce().then((success) => {
      if (stopped) return;
      failures = success ? 0 : Math.min(failures + 1, 10);
      const delay = success ? intervalMs : Math.min(intervalMs, retryMs * 2 ** (failures - 1));
      timer = setTimeout(schedule, delay);
      timer.unref();
    });
  }
  return {
    runOnce,
    start: () => {
      if (!started && !stopped) {
        started = true;
        schedule();
      }
    },
    // No store promise is awaited here: shared core shutdown deadline remains
    // authoritative. Aborted transport cannot later confirm an in-flight write.
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller.abort();
      options.client.close();
    },
  };
}
