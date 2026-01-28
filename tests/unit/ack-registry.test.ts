/**
 * Tests for SignalAckRegistry - unified deferral/acknowledgment mechanism.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SignalAckRegistry, createAckRegistry } from '../../src/layers/aggregation/ack-registry.js';

// Mock logger
const mockLogger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => mockLogger,
};

function createTestLogger() {
  return mockLogger as any;
}

describe('SignalAckRegistry', () => {
  let registry: SignalAckRegistry;

  beforeEach(() => {
    registry = createAckRegistry(createTestLogger());
  });

  describe('Basic operations', () => {
    it('allows signals when no ack registered', () => {
      const result = registry.checkBlocked('contact_urge');

      expect(result.blocked).toBe(false);
      expect(result.isOverride).toBe(false);
      expect(result.reason).toContain('No ack registered');
    });

    it('registers and retrieves acks', () => {
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000), // 1 hour
        reason: 'User busy',
      });

      const ack = registry.getAck('contact_urge');
      expect(ack).toBeDefined();
      expect(ack?.signalType).toBe('contact_urge');
      expect(ack?.ackType).toBe('deferred');
      expect(ack?.reason).toBe('User busy');
    });

    it('clears specific ack', () => {
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        reason: 'Test',
      });

      const cleared = registry.clearAck('contact_urge');
      expect(cleared).toBe(true);

      const ack = registry.getAck('contact_urge');
      expect(ack).toBeUndefined();
    });

    it('clears all acks', () => {
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        reason: 'Test 1',
      });

      registry.registerAck({
        signalType: 'pattern_break',
        ackType: 'suppressed',
        reason: 'Test 2',
      });

      registry.clearAll();

      expect(registry.getAllAcks()).toHaveLength(0);
    });
  });

  describe('Handled acks', () => {
    it('clears handled ack on next check (transient)', () => {
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'handled',
        reason: 'Processed',
      });

      // First check - should not block and should clear
      const result = registry.checkBlocked('contact_urge');
      expect(result.blocked).toBe(false);

      // Ack should be cleared
      const ack = registry.getAck('contact_urge');
      expect(ack).toBeUndefined();
    });
  });

  describe('Suppressed acks', () => {
    it('blocks signal indefinitely when suppressed', () => {
      registry.registerAck({
        signalType: 'pattern_break',
        ackType: 'suppressed',
        reason: 'Not interested',
      });

      const result = registry.checkBlocked('pattern_break');

      expect(result.blocked).toBe(true);
      expect(result.blockingAck).toBeDefined();
      expect(result.reason).toContain('suppressed');
    });
  });

  describe('Deferred acks', () => {
    it('blocks signal until deferral expires', () => {
      const deferUntil = new Date(Date.now() + 3600000); // 1 hour from now

      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil,
        reason: 'User busy',
      });

      const result = registry.checkBlocked('contact_urge');

      expect(result.blocked).toBe(true);
      expect(result.isOverride).toBe(false);
      expect(result.blockingAck?.deferUntil).toEqual(deferUntil);
    });

    it('allows signal after deferral expires', () => {
      const deferUntil = new Date(Date.now() - 1000); // Already expired

      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil,
        reason: 'User busy',
      });

      const result = registry.checkBlocked('contact_urge');

      expect(result.blocked).toBe(false);
      expect(result.isOverride).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('overrides deferral when value increases significantly', () => {
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        valueAtAck: 0.5,
        overrideDelta: 0.25, // Need 25% increase to override
        reason: 'User busy',
      });

      // Small increase - still blocked
      const result1 = registry.checkBlocked('contact_urge', undefined, 0.6);
      expect(result1.blocked).toBe(true);

      // Re-register since check cleared it
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        valueAtAck: 0.5,
        overrideDelta: 0.25,
        reason: 'User busy',
      });

      // Large increase - override
      const result2 = registry.checkBlocked('contact_urge', undefined, 0.8);
      expect(result2.blocked).toBe(false);
      expect(result2.isOverride).toBe(true);
      expect(result2.reason).toContain('overridden');
    });

    it('uses default override delta when not specified', () => {
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        valueAtAck: 0.5,
        // No overrideDelta - should use default (0.25)
        reason: 'User busy',
      });

      const ack = registry.getAck('contact_urge');
      expect(ack?.overrideDelta).toBe(0.25); // Default value
    });

    it('caps deferral duration to maximum', () => {
      const logger = createTestLogger();
      const customRegistry = createAckRegistry(logger, {
        maxDeferralMs: 1000, // 1 second max
      });

      customRegistry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000), // Try 1 hour
        reason: 'User busy',
      });

      const ack = customRegistry.getAck('contact_urge');
      const maxExpected = Date.now() + 1000 + 100; // Allow 100ms tolerance
      expect(ack?.deferUntil?.getTime()).toBeLessThan(maxExpected);
    });
  });

  describe('Source-specific acks', () => {
    it('distinguishes acks by source', () => {
      registry.registerAck({
        signalType: 'contact_pressure',
        source: 'neuron.contact_pressure',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        reason: 'Specific source',
      });

      // Check without source - should not find
      const result1 = registry.checkBlocked('contact_pressure');
      expect(result1.blocked).toBe(false);

      // Check with matching source - should block
      const result2 = registry.checkBlocked('contact_pressure', 'neuron.contact_pressure');
      expect(result2.blocked).toBe(true);
    });
  });

  describe('Pruning', () => {
    it('prunes expired deferrals', () => {
      // Add expired deferral
      registry.registerAck({
        signalType: 'contact_urge',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() - 1000), // Already expired
        reason: 'Expired',
      });

      // Add active suppression
      registry.registerAck({
        signalType: 'pattern_break',
        ackType: 'suppressed',
        reason: 'Active',
      });

      const pruned = registry.pruneExpired();

      expect(pruned).toBe(1);
      expect(registry.getAck('contact_urge')).toBeUndefined();
      expect(registry.getAck('pattern_break')).toBeDefined();
    });
  });

  describe('Works with any signal type', () => {
    it('defers pattern_break signals', () => {
      registry.registerAck({
        signalType: 'pattern_break',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        reason: 'Not important now',
      });

      const result = registry.checkBlocked('pattern_break');
      expect(result.blocked).toBe(true);
    });

    it('defers threshold_crossed signals', () => {
      registry.registerAck({
        signalType: 'threshold_crossed',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        valueAtAck: 0.7,
        reason: 'Will check later',
      });

      const result = registry.checkBlocked('threshold_crossed', undefined, 0.75);
      expect(result.blocked).toBe(true);
    });

    it('defers social_debt signals', () => {
      registry.registerAck({
        signalType: 'social_debt',
        ackType: 'deferred',
        deferUntil: new Date(Date.now() + 3600000),
        reason: 'Low priority',
      });

      const result = registry.checkBlocked('social_debt');
      expect(result.blocked).toBe(true);
    });
  });
});
