/**
 * In-Memory Lease-Based Lock Service
 *
 * Provides mutual exclusion for script execution. Locks have a lease duration
 * and auto-release if the holder crashes (lease expiry). Waiters are queued
 * FIFO and popped when the current holder releases.
 *
 * Design:
 * - In-memory only (no persistence) — locks are ephemeral per process lifetime
 * - Lease-based: auto-releases after leaseMs if not renewed
 * - FIFO waiter queue for 'block' wait policy
 * - renew() extends lease by original leaseMs from now
 */

import { randomBytes } from 'node:crypto';
import type { LockHandle, LockService } from '../motor-cortex/script-types.js';

interface LockEntry {
  handle: LockHandle;
  /** Timer for auto-releasing on lease expiry */
  expiryTimer: ReturnType<typeof setTimeout>;
  /** FIFO queue of waiters */
  waiters: {
    resolve: (handle: LockHandle) => void;
    reject: (error: Error) => void;
    leaseMs: number;
    timer: ReturnType<typeof setTimeout>;
  }[];
}

/**
 * Create an in-memory lock service.
 */
export function createLockService(): LockService {
  const locks = new Map<string, LockEntry>();

  function generateHandleId(): string {
    return `lock_${randomBytes(6).toString('hex')}`;
  }

  function isExpired(handle: LockHandle): boolean {
    return handle.acquiredAt + handle.leaseMs < Date.now();
  }

  function createHandle(key: string, leaseMs: number): LockHandle {
    return {
      id: generateHandleId(),
      key,
      acquiredAt: Date.now(),
      leaseMs,
    };
  }

  function grantLock(key: string, leaseMs: number): LockHandle {
    const handle = createHandle(key, leaseMs);

    const expiryTimer = setTimeout(() => {
      // Lease expired — auto-release
      const entry = locks.get(key);
      if (entry?.handle.id === handle.id) {
        releaseInternal(key, entry);
      }
    }, leaseMs);

    const entry: LockEntry = {
      handle,
      expiryTimer,
      waiters: [],
    };
    locks.set(key, entry);
    return handle;
  }

  function releaseInternal(key: string, entry: LockEntry): void {
    clearTimeout(entry.expiryTimer);

    // Pop next waiter from FIFO queue
    const nextWaiter = entry.waiters.shift();
    if (nextWaiter) {
      clearTimeout(nextWaiter.timer);
      const newHandle = grantLock(key, nextWaiter.leaseMs);
      // Preserve remaining waiters on the new entry
      const newEntry = locks.get(key);
      if (newEntry) {
        newEntry.waiters = entry.waiters;
      }
      nextWaiter.resolve(newHandle);
    } else {
      locks.delete(key);
    }
  }

  return {
    async acquire(key, options): Promise<LockHandle> {
      const { waitPolicy, waitTimeoutMs, leaseMs } = options;

      // Check for existing lock
      const existing = locks.get(key);
      if (existing) {
        // Check if lease expired (lazy cleanup)
        if (isExpired(existing.handle)) {
          releaseInternal(key, existing);
          // Fall through to grant
        } else {
          // Lock is held — apply wait policy
          if (waitPolicy === 'fail_fast') {
            throw new Error(`Lock unavailable: ${key} (held by ${existing.handle.id})`);
          }

          // Block: queue waiter with timeout
          const timeout = waitTimeoutMs ?? 10_000;
          return new Promise<LockHandle>((resolve, reject) => {
            const timer = setTimeout(() => {
              // Remove from waiter queue
              const entry = locks.get(key);
              if (entry) {
                entry.waiters = entry.waiters.filter((w) => w.resolve !== resolve);
              }
              reject(new Error(`Lock wait timeout after ${String(timeout)}ms: ${key}`));
            }, timeout);

            existing.waiters.push({ resolve, reject, leaseMs, timer });
          });
        }
      }

      // No lock held — grant immediately
      return grantLock(key, leaseMs);
    },

    renew(handle: LockHandle): void {
      const entry = locks.get(handle.key);
      if (entry?.handle.id !== handle.id) {
        return; // Lock already released or held by someone else
      }

      // Clear old expiry timer
      clearTimeout(entry.expiryTimer);

      // Update acquiredAt and set new expiry timer
      entry.handle.acquiredAt = Date.now();
      entry.expiryTimer = setTimeout(() => {
        const current = locks.get(handle.key);
        if (current?.handle.id === handle.id) {
          releaseInternal(handle.key, current);
        }
      }, handle.leaseMs);
    },

    release(handle: LockHandle): void {
      const entry = locks.get(handle.key);
      if (entry?.handle.id !== handle.id) {
        return; // Already released or held by someone else
      }
      releaseInternal(handle.key, entry);
    },

    pruneExpired(): void {
      for (const [key, entry] of locks) {
        if (isExpired(entry.handle)) {
          releaseInternal(key, entry);
        }
      }
    },
  };
}
