/**
 * Plugin Error Types
 *
 * Typed error classes for plugin lifecycle operations.
 * Enables intelligent retry logic and clear error handling.
 */

/**
 * Plugin error codes for classification.
 */
export type PluginErrorCode =
  | 'VALIDATION_FAILED'
  | 'DEPENDENCY_MISSING'
  | 'ACTIVATION_FAILED'
  | 'ALREADY_LOADED'
  | 'NOT_LOADED'
  | 'REQUIRED_PLUGIN';

/**
 * Base plugin error class.
 */
export class PluginError extends Error {
  constructor(
    public readonly pluginId: string,
    message: string,
    public readonly code: PluginErrorCode
  ) {
    super(`Plugin ${pluginId}: ${message}`);
    this.name = 'PluginError';
  }
}

/**
 * Plugin manifest validation failed.
 * Should not retry - fix the manifest.
 */
export class ValidationError extends PluginError {
  constructor(pluginId: string, message: string) {
    super(pluginId, message, 'VALIDATION_FAILED');
    this.name = 'ValidationError';
  }
}

/**
 * Plugin dependency not satisfied.
 * Should not retry - load dependencies first.
 */
export class DependencyError extends PluginError {
  constructor(
    pluginId: string,
    public readonly missingDependency: string,
    message?: string
  ) {
    super(
      pluginId,
      message ?? `requires ${missingDependency} which is not loaded`,
      'DEPENDENCY_MISSING'
    );
    this.name = 'DependencyError';
  }
}

/**
 * Plugin activation (lifecycle.activate) failed.
 * May retry with backoff for transient failures.
 */
export class ActivationError extends PluginError {
  constructor(pluginId: string, message: string) {
    super(pluginId, message, 'ACTIVATION_FAILED');
    this.name = 'ActivationError';
  }
}

/**
 * Plugin is already loaded.
 * Use hotSwap() instead.
 */
export class AlreadyLoadedError extends PluginError {
  constructor(pluginId: string) {
    super(pluginId, 'already loaded. Use hotSwap() to update.', 'ALREADY_LOADED');
    this.name = 'AlreadyLoadedError';
  }
}

/**
 * Plugin is not loaded.
 * Cannot pause/resume/unload a plugin that isn't loaded.
 */
export class NotLoadedError extends PluginError {
  constructor(pluginId: string, operation: string) {
    super(pluginId, `not loaded, cannot ${operation}`, 'NOT_LOADED');
    this.name = 'NotLoadedError';
  }
}

/**
 * Attempted to modify a required plugin.
 * Required plugins cannot be paused, unloaded, or restarted.
 */
export class RequiredPluginError extends PluginError {
  constructor(pluginId: string, operation: string) {
    super(pluginId, `is required and cannot be ${operation}`, 'REQUIRED_PLUGIN');
    this.name = 'RequiredPluginError';
  }
}
