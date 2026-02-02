/**
 * Test: Calories plugin user model data flow
 *
 * Verifies that user stats saved via core.remember are correctly
 * read by the calories plugin's getUserModel function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulate the createGetUserModel function from calories/index.ts
interface UserModelData {
  weight_kg?: number;
  height_cm?: number;
  birthday?: string;
  gender?: string;
  activity_level?: string;
  calorie_goal?: number;
  target_weight_kg?: number;
}

interface UserPropertySnapshot {
  value: unknown;
  confidence: number;
  source: string;
  updatedAt: Date;
}

type GetUserPropertyFunc = (attr: string, recipientId?: string) => UserPropertySnapshot | null;

function createGetUserModel(
  getUserProperty: GetUserPropertyFunc
): (recipientId: string) => Promise<UserModelData | null> {
  return (recipientId: string) => {
    const getProp = (attr: string): unknown => {
      const prop = getUserProperty(attr, recipientId);
      return prop?.value;
    };

    const weight = getProp('weight_kg');
    const height = getProp('height_cm');
    const birthday = getProp('birthday');
    const gender = getProp('gender');
    const activity = getProp('activity_level');
    const goal = getProp('calorie_goal');
    const target = getProp('target_weight_kg');

    // Return null if no data at all
    if (!weight && !height && !birthday && !gender) {
      return Promise.resolve(null);
    }

    // Build result only with defined values
    const result: UserModelData = {};

    // BUG: These checks fail when value is stored as string '87.8' instead of number 87.8
    if (typeof weight === 'number') result.weight_kg = weight;
    if (typeof height === 'number') result.height_cm = height;

    if (typeof birthday === 'string') result.birthday = birthday;
    if (typeof gender === 'string') result.gender = gender;

    return Promise.resolve(result);
  };
}

describe('Calories plugin user model data flow', () => {
  describe('BUG: String values from core.remember', () => {
    it('should handle weight_kg stored as string (current broken behavior)', async () => {
      // Simulate how core.remember stores values - as STRINGS
      const mockGetUserProperty: GetUserPropertyFunc = (attr) => {
        const store: Record<string, UserPropertySnapshot> = {
          weight_kg: { value: '87.8', confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
          height_cm: { value: '185', confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
          gender: { value: 'male', confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
        };
        return store[attr] ?? null;
      };

      const getUserModel = createGetUserModel(mockGetUserProperty);
      const result = await getUserModel('test-recipient');

      // Current broken behavior: weight_kg and height_cm are missing because they're strings
      expect(result).not.toBeNull();
      expect(result?.weight_kg).toBeUndefined(); // BUG: Should be 87.8
      expect(result?.height_cm).toBeUndefined(); // BUG: Should be 185
      expect(result?.gender).toBe('male'); // Works because it's already a string
    });

    it('should work correctly when values are stored as numbers', async () => {
      // If values were stored as numbers, it would work
      const mockGetUserProperty: GetUserPropertyFunc = (attr) => {
        const store: Record<string, UserPropertySnapshot> = {
          weight_kg: { value: 87.8, confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
          height_cm: { value: 185, confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
          gender: { value: 'male', confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
        };
        return store[attr] ?? null;
      };

      const getUserModel = createGetUserModel(mockGetUserProperty);
      const result = await getUserModel('test-recipient');

      expect(result).not.toBeNull();
      expect(result?.weight_kg).toBe(87.8);
      expect(result?.height_cm).toBe(185);
      expect(result?.gender).toBe('male');
    });
  });

  describe('FIX: Parse string values as numbers', () => {
    // Fixed version of createGetUserModel that parses string numbers
    function createGetUserModelFixed(
      getUserProperty: GetUserPropertyFunc
    ): (recipientId: string) => Promise<UserModelData | null> {
      return (recipientId: string) => {
        const getProp = (attr: string): unknown => {
          const prop = getUserProperty(attr, recipientId);
          return prop?.value;
        };

        const parseNumber = (val: unknown): number | undefined => {
          if (typeof val === 'number') return val;
          if (typeof val === 'string') {
            const parsed = parseFloat(val);
            if (!isNaN(parsed)) return parsed;
          }
          return undefined;
        };

        const weight = getProp('weight_kg');
        const height = getProp('height_cm');
        const birthday = getProp('birthday');
        const gender = getProp('gender');
        const activity = getProp('activity_level');
        const goal = getProp('calorie_goal');
        const target = getProp('target_weight_kg');

        // Return null if no data at all
        if (!weight && !height && !birthday && !gender) {
          return Promise.resolve(null);
        }

        // Build result with type coercion for numeric fields
        const result: UserModelData = {};

        const parsedWeight = parseNumber(weight);
        const parsedHeight = parseNumber(height);
        const parsedGoal = parseNumber(goal);
        const parsedTarget = parseNumber(target);

        if (parsedWeight !== undefined) result.weight_kg = parsedWeight;
        if (parsedHeight !== undefined) result.height_cm = parsedHeight;
        if (parsedGoal !== undefined) result.calorie_goal = parsedGoal;
        if (parsedTarget !== undefined) result.target_weight_kg = parsedTarget;

        if (typeof birthday === 'string') result.birthday = birthday;
        if (typeof gender === 'string') result.gender = gender;
        if (typeof activity === 'string') result.activity_level = activity;

        return Promise.resolve(result);
      };
    }

    it('should correctly parse string values as numbers', async () => {
      const mockGetUserProperty: GetUserPropertyFunc = (attr) => {
        const store: Record<string, UserPropertySnapshot> = {
          weight_kg: { value: '87.8', confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
          height_cm: { value: '185', confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
          gender: { value: 'male', confidence: 0.95, source: 'user_explicit', updatedAt: new Date() },
        };
        return store[attr] ?? null;
      };

      const getUserModel = createGetUserModelFixed(mockGetUserProperty);
      const result = await getUserModel('test-recipient');

      expect(result).not.toBeNull();
      expect(result?.weight_kg).toBe(87.8);
      expect(result?.height_cm).toBe(185);
      expect(result?.gender).toBe('male');
    });
  });
});
