/** Capture wiring: disabled capture reads no secret inventory; retention still runs. */
import { renderAttemptHeaders, type ModelSlotName, type SlotRead } from './model.js';
import { prepareCaptureSecrets, type CaptureContext } from './model-exchange-capture.js';
import type { ModelCaptureSetting } from './model-capture-setting.js';

export function createCaptureInventory(options: {
  setting: { current(): ModelCaptureSetting; refresh(): Promise<void> };
  readSlot(name: ModelSlotName): Promise<SlotRead>;
  passwords(): Promise<readonly string[]>;
  /** Prune retained evidence and report whether any rows remain. */
  prune(): Promise<boolean>;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  let inventory:
    | {
        slots: Map<ModelSlotName, SlotRead>;
        prepared: readonly string[];
        sessions: Map<string, readonly string[]>;
        headers: string[];
        refreshed: number;
      }
    | undefined;
  let refreshing: Promise<void> | undefined;
  let closed = false;
  // Unknown after restart: always prune once, even with capture disabled.
  let retainedRows = true;
  let writes = 0;
  let nextPrune = 0;
  let pruning = false;
  function setting(sessionId?: string | null): ModelCaptureSetting | undefined {
    const value = options.setting.current();
    return value.until !== null &&
      Date.parse(value.until) > now() &&
      (sessionId === undefined || value.session === undefined || value.session === sessionId)
      ? value
      : undefined;
  }
  function enabled(sessionId?: string | null): boolean {
    return (
      !closed &&
      setting(sessionId) !== undefined &&
      inventory !== undefined &&
      now() - inventory.refreshed < 60_000
    );
  }
  function prune(on: boolean): void {
    // Turning capture back on must not inherit the slower off-state schedule.
    if (on && nextPrune > now() + 60_000) nextPrune = now();
    if (closed || pruning || (!on && !retainedRows) || now() < nextPrune) return;
    nextPrune = now() + (on ? 60_000 : 60 * 60 * 1000);
    pruning = true;
    const observedWrites = writes;
    void options
      .prune()
      .then((remaining) => {
        // Enabled capture can append after this query, so only an off prune
        // can establish that maintenance may stop.
        retainedRows = on || remaining || writes !== observedWrites;
      })
      .catch(() => {
        // Unknown is not empty. Retry maintenance after a transient failure.
        retainedRows = true;
      })
      .finally(() => {
        pruning = false;
      });
  }
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    if (closed) return Promise.resolve();
    // Disable admission until setting and secret material form one fresh generation.
    inventory = undefined;
    refreshing = (async () => {
      try {
        await options.setting.refresh();
        const on = setting() !== undefined;
        prune(on);
        if (!on || closed) return;
        const [primary, reserve, passwords] = await Promise.all([
          options.readSlot('primary'),
          options.readSlot('reserve'),
          options.passwords(),
        ]);
        if (closed || setting() === undefined) return;
        const slots = new Map<ModelSlotName, SlotRead>([
          ['primary', primary],
          ['reserve', reserve],
        ]);
        const present = [primary, reserve].flatMap((read) =>
          read.state === 'present' ? [read.slot] : []
        );
        const secrets = [
          ...passwords,
          ...present.flatMap((slot) => [slot.key ?? '', ...renderAttemptHeaders(slot, '').secrets]),
        ].filter(Boolean);
        inventory = {
          slots,
          prepared: prepareCaptureSecrets(secrets),
          sessions: new Map(),
          headers: present.flatMap((slot) => (slot.headers ?? []).map((header) => header.name)),
          refreshed: now(),
        };
      } catch {
        inventory = undefined;
        // Retention does not depend on a successful settings/secret refresh.
        prune(false);
      } finally {
        refreshing = undefined;
      }
    })();
    return refreshing;
  }
  return {
    enabled,
    refresh,
    /** An already-admitted collector can finish after capture turns off. */
    noteWrite() {
      if (closed) return;
      retainedRows = true;
      writes++;
    },
    close() {
      closed = true;
      inventory = undefined;
    },
    context(sessionId: string | null): CaptureContext | undefined {
      if (!enabled(sessionId) || !inventory) return undefined;
      const current = setting(sessionId);
      if (!current) return undefined;
      const session = sessionId ?? '';
      let prepared = inventory.sessions.get(session);
      if (!prepared) {
        const rendered = [...inventory.slots.values()].flatMap((read) =>
          read.state === 'present' ? renderAttemptHeaders(read.slot, session).secrets : []
        );
        prepared = [...new Set([...inventory.prepared, ...prepareCaptureSecrets(rendered)])];
        // Bound session-derived material independently of model request volume.
        if (inventory.sessions.size >= 16) inventory.sessions.clear();
        inventory.sessions.set(session, prepared);
      }
      return {
        setting: current,
        secrets: [],
        preparedSecrets: prepared,
        secretHeaders: inventory.headers,
      };
    },
    observeSlot(name: ModelSlotName, read: SlotRead): void {
      if (!enabled() || !inventory) return;
      const previous = inventory.slots.get(name);
      if (
        previous?.state !== read.state ||
        (read.state === 'present' &&
          previous?.state === 'present' &&
          read.version !== previous.version)
      ) {
        inventory = undefined;
        void refresh();
      }
    },
  };
}
