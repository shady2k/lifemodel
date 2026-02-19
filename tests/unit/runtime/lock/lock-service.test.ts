import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLockService } from '../../../../src/runtime/lock/lock-service.js';
import type { LockService } from '../../../../src/runtime/motor-cortex/script-types.js';

describe('LockService', () => {
  let lockService: LockService;

  beforeEach(() => {
    vi.useFakeTimers();
    lockService = createLockService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('acquire', () => {
    it('should acquire a lock when not held', async () => {
      const handle = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      expect(handle.key).toBe('test-key');
      expect(handle.id).toMatch(/^lock_/);
      expect(handle.leaseMs).toBe(5000);
      expect(handle.acquiredAt).toBeGreaterThan(0);
    });

    it('should fail_fast when lock is already held', async () => {
      await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      await expect(
        lockService.acquire('test-key', {
          waitPolicy: 'fail_fast',
          leaseMs: 5000,
        })
      ).rejects.toThrow('Lock unavailable');
    });

    it('should allow independent keys', async () => {
      const handle1 = await lockService.acquire('key-a', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });
      const handle2 = await lockService.acquire('key-b', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      expect(handle1.key).toBe('key-a');
      expect(handle2.key).toBe('key-b');
    });
  });

  describe('release', () => {
    it('should allow re-acquisition after release', async () => {
      const handle1 = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      lockService.release(handle1);

      const handle2 = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      expect(handle2.id).not.toBe(handle1.id);
    });

    it('should be idempotent (double release is safe)', async () => {
      const handle = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      lockService.release(handle);
      lockService.release(handle); // No error
    });
  });

  describe('block + timeout', () => {
    it('should block and acquire when lock is released', async () => {
      const handle1 = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      // Start a blocked acquire
      const acquirePromise = lockService.acquire('test-key', {
        waitPolicy: 'block',
        waitTimeoutMs: 10000,
        leaseMs: 5000,
      });

      // Release the first lock
      lockService.release(handle1);

      const handle2 = await acquirePromise;
      expect(handle2.key).toBe('test-key');
      expect(handle2.id).not.toBe(handle1.id);
    });

    it('should reject on block timeout', async () => {
      await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 30000, // Long lease
      });

      const acquirePromise = lockService.acquire('test-key', {
        waitPolicy: 'block',
        waitTimeoutMs: 1000,
        leaseMs: 5000,
      });

      vi.advanceTimersByTime(1001);

      await expect(acquirePromise).rejects.toThrow('Lock wait timeout');
    });
  });

  describe('lease expiry', () => {
    it('should auto-release after lease expires', async () => {
      await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      // Advance time past lease
      vi.advanceTimersByTime(5001);

      // Should be able to acquire now (lease expired)
      const handle2 = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      expect(handle2.key).toBe('test-key');
    });

    it('should grant to waiter when lease expires', async () => {
      await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 2000,
      });

      const acquirePromise = lockService.acquire('test-key', {
        waitPolicy: 'block',
        waitTimeoutMs: 5000,
        leaseMs: 3000,
      });

      // Advance past lease expiry
      vi.advanceTimersByTime(2001);

      const handle2 = await acquirePromise;
      expect(handle2.key).toBe('test-key');
    });
  });

  describe('renewal', () => {
    it('should extend lease on renew', async () => {
      const handle = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      // Advance 4s (almost expired)
      vi.advanceTimersByTime(4000);

      // Renew
      lockService.renew(handle);

      // Advance another 4s (would have expired without renewal)
      vi.advanceTimersByTime(4000);

      // Lock should still be held
      await expect(
        lockService.acquire('test-key', {
          waitPolicy: 'fail_fast',
          leaseMs: 5000,
        })
      ).rejects.toThrow('Lock unavailable');

      // Advance past the renewed lease
      vi.advanceTimersByTime(2000);

      // Now it should be available
      const handle2 = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });
      expect(handle2.key).toBe('test-key');
    });

    it('should be no-op for released lock', async () => {
      const handle = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      lockService.release(handle);
      lockService.renew(handle); // No error, no-op
    });
  });

  describe('FIFO waiter ordering', () => {
    it('should grant to waiters in FIFO order', async () => {
      const handle1 = await lockService.acquire('test-key', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      const order: number[] = [];

      const promise1 = lockService
        .acquire('test-key', {
          waitPolicy: 'block',
          waitTimeoutMs: 10000,
          leaseMs: 1000,
        })
        .then((h) => {
          order.push(1);
          lockService.release(h);
        });

      const promise2 = lockService
        .acquire('test-key', {
          waitPolicy: 'block',
          waitTimeoutMs: 10000,
          leaseMs: 1000,
        })
        .then((h) => {
          order.push(2);
          lockService.release(h);
        });

      // Release first lock — should grant to waiter 1 first, then waiter 2
      lockService.release(handle1);

      await Promise.all([promise1, promise2]);
      expect(order).toEqual([1, 2]);
    });
  });

  describe('pruneExpired', () => {
    it('should clean up expired locks', async () => {
      await lockService.acquire('key-a', {
        waitPolicy: 'fail_fast',
        leaseMs: 1000,
      });
      await lockService.acquire('key-b', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });

      vi.advanceTimersByTime(2000);
      lockService.pruneExpired();

      // key-a should be available (expired and pruned)
      const handle = await lockService.acquire('key-a', {
        waitPolicy: 'fail_fast',
        leaseMs: 5000,
      });
      expect(handle.key).toBe('key-a');

      // key-b should still be held
      await expect(
        lockService.acquire('key-b', {
          waitPolicy: 'fail_fast',
          leaseMs: 5000,
        })
      ).rejects.toThrow('Lock unavailable');
    });
  });
});
