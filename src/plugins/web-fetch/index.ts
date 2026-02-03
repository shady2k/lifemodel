/**
 * Web Fetch Plugin
 *
 * Fetches web pages and converts them to markdown.
 * Provides SSRF protection, robots.txt compliance, and content sanitization.
 */

import type {
  PluginV2,
  PluginManifestV2,
  PluginLifecycleV2,
  PluginPrimitives,
  PluginTool,
} from '../../types/plugin.js';
import { createFetchTool } from './fetch-tool.js';

/**
 * Plugin ID.
 */
export const WEB_FETCH_PLUGIN_ID = 'web-fetch';

/**
 * Plugin state (set during activation).
 */
let pluginPrimitives: PluginPrimitives | null = null;
let pluginTools: PluginTool[] = [];

/**
 * Plugin manifest.
 */
const manifest: PluginManifestV2 = {
  manifestVersion: 2,
  id: WEB_FETCH_PLUGIN_ID,
  name: 'Web Fetch',
  version: '1.0.0',
  description: 'Fetch web pages and convert to markdown',
  provides: [{ type: 'tool', id: 'fetch' }],
  requires: ['logger'],
};

/**
 * Plugin lifecycle.
 */
const lifecycle: PluginLifecycleV2 = {
  /**
   * Activate the plugin.
   */
  activate(primitives: PluginPrimitives): void {
    pluginPrimitives = primitives;
    primitives.logger.info('Web Fetch plugin activating');

    // Create tools
    pluginTools = [createFetchTool(primitives)];

    primitives.logger.info('Web Fetch plugin activated');
  },

  /**
   * Deactivate the plugin.
   */
  deactivate(): void {
    if (pluginPrimitives) {
      pluginPrimitives.logger.info('Web Fetch plugin deactivating');
    }
    pluginPrimitives = null;
    pluginTools = [];
  },

  /**
   * Health check.
   */
  healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    if (!pluginPrimitives) {
      return Promise.resolve({ healthy: false, message: 'Plugin not activated' });
    }

    // The plugin doesn't have external dependencies that need checking
    // It uses native fetch and pure TypeScript libraries
    return Promise.resolve({ healthy: true });
  },
};

/**
 * Get plugin tools (for manual registration if needed).
 */
export function getTools(): PluginTool[] {
  return pluginTools;
}

/**
 * The web fetch plugin instance.
 */
const webFetchPlugin: PluginV2 = {
  manifest,
  lifecycle,
  get tools() {
    return pluginTools;
  },
};

export default webFetchPlugin;
