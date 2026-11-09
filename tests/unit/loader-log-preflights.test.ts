/**
 * The two log pre-flights in front of the loader's first-start phase plan
 * (ADR-016 §5). The claim check runs on every attempt and may throw, because a
 * Pending claim is what keeps the store from starting; the partition key check
 * follows it and never blocks the plan.
 */
import { describe, expect, it } from 'vitest';
import { createLogPreflights } from '../../loader/src/app.js';

describe('the log pre-flights in front of the phase plan', () => {
  it('checks the claim first and the partition key second', async () => {
    const steps: string[] = [];
    await createLogPreflights({
      volumeClaim: {
        run: async () => {
          steps.push('claim');
        },
      },
      partitionKey: {
        run: async () => {
          steps.push('key');
        },
      },
    }).run();
    expect(steps).toEqual(['claim', 'key']);
  });

  it('does not reach the key check when the claim cannot be made claimable', async () => {
    const steps: string[] = [];
    const outcome = createLogPreflights({
      volumeClaim: {
        run: async () => {
          steps.push('claim');
          throw new Error('claim refused');
        },
      },
      partitionKey: {
        run: async () => {
          steps.push('key');
        },
      },
    }).run();
    await expect(outcome).rejects.toThrow('claim refused');
    expect(steps).toEqual(['claim']);
  });
});
