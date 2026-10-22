import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { SnapshotStore } from '../storage/snapshot-store.js';
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
    for (const plan of page.plans) {
      if (stopped) return false;
      try {
        const event = await options.snapshotStore.commitNotice(options.epoch, {
          eventId: storageWarningEventId(plan.id),
          type: 'send.command',
          payload: {
            recipientId: options.recipientId,
            ...options.route,
            text: notice(plan, options.language()),
          },
        });
        if (stopped) return false;
        // Publish the same committed event to the web owner's pull surface.
        // This natural-keyed projection is safe after a lost reply or trimming.
        const payload = event.payload as { recipientId: string; channel: string; text: string };
        await options.conversations.addMessage(
          payload.recipientId,
          { role: 'assistant', content: payload.text },
          { channel: payload.channel, channelMessageId: event.eventId }
        );
        if (stopped) return false;
        await options.client.warningCommitted(plan.id, event.eventId, controller.signal);
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
