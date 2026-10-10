import { clearTimeout, setTimeout } from 'node:timers';

import type { FileSystem } from '../../loader/src/fs.js';

/**
 * A fixture-local admission fence and native-I/O settlement tracker.
 * This helper does not own, delete, or release the fixture's root.
 */
export class FixtureLifetime {
  private closed = false;
  private readonly admitted = new Set<object>();
  private readonly drainListeners = new Set<() => void>();

  /** Permanently revoke admission. Already admitted operations continue. */
  closeAdmission(): void {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  admittedCount(): number {
    return this.admitted.size;
  }

  private settled(token: object): void {
    this.admitted.delete(token);
    for (const listener of this.drainListeners) listener();
  }

  private delegate<T>(callback: () => Promise<T>): Promise<T> {
    // No delegation, timer, socket, or other native handle after closure.
    if (this.closed) return new Promise<T>(() => {});

    // Reserve synchronously, including during the delegate's initial work.
    const token = {};
    this.admitted.add(token);

    let original: Promise<T>;
    try {
      original = callback();
    } catch (error) {
      this.settled(token);
      throw error;
    }

    // Observe the entire original operation, not an intermediate I/O step.
    // Both handlers return normally: the derived promise cannot reject.
    // Return the original promise so its result and rejection stay intact.
    void original.then(
      () => this.settled(token),
      () => this.settled(token)
    );
    return original;
  }

  wrapFs(base: FileSystem): FileSystem {
    return {
      exists: (path) => this.delegate(() => base.exists(path)),
      isDirectory: (path) => this.delegate(() => base.isDirectory(path)),
      ensureDir: (path, mode) =>
        this.delegate(() => base.ensureDir(path, mode)),
      createDirIfMissing: (path, mode) =>
        this.delegate(() => base.createDirIfMissing(path, mode)),
      readFile: (path) => this.delegate(() => base.readFile(path)),
      writeFileAtomic: (path, contents, mode) =>
        this.delegate(() => base.writeFileAtomic(path, contents, mode)),
      remove: (path) => this.delegate(() => base.remove(path)),
      chmod: (path, mode) => this.delegate(() => base.chmod(path, mode)),
      chown: (path, uid, gid) =>
        this.delegate(() => base.chown(path, uid, gid)),
      chownFreshTree: (path, uid, gid) =>
        this.delegate(() => base.chownFreshTree(path, uid, gid)),
    };
  }

  /**
   * Wait for resource settlement, not successful operation results.
   * Admission must already be closed. A timeout never permits deletion.
   * Pending operations remain tracked and a later drain can be attempted.
   *
   * Uses Node timers and Date.now, never the world's manual clock.
   * Callers must not replace Date.now with a fake clock during this drain.
   */
  drainNativeIo(timeoutMs: number): Promise<void> {
    if (!this.closed) {
      return Promise.reject(
        new Error('Close fixture admission before draining native I/O')
      );
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(
        new RangeError('timeoutMs must be finite and nonnegative')
      );
    }

    const deadline = Date.now() + timeoutMs;
    if (!Number.isFinite(deadline)) {
      return Promise.reject(new RangeError('Drain deadline must be finite'));
    }
    if (this.admitted.size === 0) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;

      const finish = (error?: Error): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        this.drainListeners.delete(check);
        if (error === undefined) resolve();
        else reject(error);
      };

      const check = (): void => {
        if (finished) return;
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          finish(
            new Error(
              `Native I/O drain timed out after ${timeoutMs}ms; ` +
                `${this.admitted.size} operation(s) remain admitted. ` +
                'Retain fixture ownership and root.'
            )
          );
          return;
        }
        if (this.admitted.size === 0) {
          finish();
          return;
        }
        if (timer !== undefined) clearTimeout(timer);
        // Node clamps larger delays to 1ms; rearm at the real deadline.
        timer = setTimeout(check, Math.min(remaining, 2_147_483_647));
      };

      this.drainListeners.add(check);
      check();
    });
  }
}
