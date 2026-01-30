/**
 * Tests for plugin error types.
 */

import { describe, it, expect } from 'vitest';
import {
  PluginError,
  ValidationError,
  DependencyError,
  ActivationError,
  AlreadyLoadedError,
  NotLoadedError,
  RequiredPluginError,
} from '../../../src/core/plugin-errors.js';

describe('Plugin Errors', () => {
  describe('PluginError', () => {
    it('should include plugin ID in message', () => {
      const error = new PluginError('my-plugin', 'test message', 'VALIDATION_FAILED');
      expect(error.message).toBe('Plugin my-plugin: test message');
      expect(error.pluginId).toBe('my-plugin');
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.name).toBe('PluginError');
    });
  });

  describe('ValidationError', () => {
    it('should have VALIDATION_FAILED code', () => {
      const error = new ValidationError('test-plugin', 'invalid manifest');
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.name).toBe('ValidationError');
      expect(error.pluginId).toBe('test-plugin');
      expect(error.message).toContain('invalid manifest');
    });

    it('should be instanceof PluginError', () => {
      const error = new ValidationError('test-plugin', 'invalid');
      expect(error).toBeInstanceOf(PluginError);
      expect(error).toBeInstanceOf(Error);
    });
  });

  describe('DependencyError', () => {
    it('should have DEPENDENCY_MISSING code', () => {
      const error = new DependencyError('my-plugin', 'required-plugin');
      expect(error.code).toBe('DEPENDENCY_MISSING');
      expect(error.name).toBe('DependencyError');
      expect(error.missingDependency).toBe('required-plugin');
      expect(error.message).toContain('requires required-plugin which is not loaded');
    });

    it('should accept custom message', () => {
      const error = new DependencyError('my-plugin', 'other', 'custom error message');
      expect(error.message).toContain('custom error message');
    });
  });

  describe('ActivationError', () => {
    it('should have ACTIVATION_FAILED code', () => {
      const error = new ActivationError('my-plugin', 'failed to connect');
      expect(error.code).toBe('ACTIVATION_FAILED');
      expect(error.name).toBe('ActivationError');
      expect(error.message).toContain('failed to connect');
    });
  });

  describe('AlreadyLoadedError', () => {
    it('should have ALREADY_LOADED code', () => {
      const error = new AlreadyLoadedError('my-plugin');
      expect(error.code).toBe('ALREADY_LOADED');
      expect(error.name).toBe('AlreadyLoadedError');
      expect(error.message).toContain('already loaded');
      expect(error.message).toContain('hotSwap');
    });
  });

  describe('NotLoadedError', () => {
    it('should have NOT_LOADED code', () => {
      const error = new NotLoadedError('my-plugin', 'pause');
      expect(error.code).toBe('NOT_LOADED');
      expect(error.name).toBe('NotLoadedError');
      expect(error.message).toContain('not loaded');
      expect(error.message).toContain('pause');
    });
  });

  describe('RequiredPluginError', () => {
    it('should have REQUIRED_PLUGIN code', () => {
      const error = new RequiredPluginError('alertness', 'paused');
      expect(error.code).toBe('REQUIRED_PLUGIN');
      expect(error.name).toBe('RequiredPluginError');
      expect(error.message).toContain('required');
      expect(error.message).toContain('paused');
    });
  });

  describe('Error classification for retry logic', () => {
    it('ValidationError should not be retried', () => {
      const error = new ValidationError('test', 'invalid');
      // Retry logic checks instanceof
      expect(error instanceof ValidationError).toBe(true);
      expect(error.code).toBe('VALIDATION_FAILED');
    });

    it('DependencyError should not be retried', () => {
      const error = new DependencyError('test', 'dep');
      expect(error instanceof DependencyError).toBe(true);
      expect(error.code).toBe('DEPENDENCY_MISSING');
    });

    it('ActivationError may be retried', () => {
      const error = new ActivationError('test', 'transient failure');
      expect(error instanceof ActivationError).toBe(true);
      expect(error.code).toBe('ACTIVATION_FAILED');
      // Not a ValidationError or DependencyError, so it can be retried
      expect(error instanceof ValidationError).toBe(false);
      expect(error instanceof DependencyError).toBe(false);
    });
  });
});
