/**
 * Web Search Plugin
 *
 * Searches the web using Brave or Serper APIs.
 * Returns links and snippets - use web-fetch to get full page content.
 */

import type {
  PluginV2,
  PluginManifestV2,
  PluginLifecycleV2,
  PluginPrimitives,
  PluginTool,
} from '../../types/plugin.js';
import { createSearchTool } from './search-tool.js';
import { getProviderHealthInfo } from './providers/registry.js';

/**
 * Plugin ID.
 */
export const WEB_SEARCH_PLUGIN_ID = 'web-search';

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
  id: WEB_SEARCH_PLUGIN_ID,
  name: 'Web Search',
  version: '1.0.0',
  description: 'Search the internet via Brave or Serper',
  provides: [{ type: 'tool', id: 'search' }],
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
    primitives.logger.info('Web Search plugin activating');

    // Create tools
    pluginTools = [createSearchTool(primitives)];

    primitives.logger.info('Web Search plugin activated');
  },

  /**
   * Deactivate the plugin.
   */
  deactivate(): void {
    if (pluginPrimitives) {
      pluginPrimitives.logger.info('Web Search plugin deactivating');
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

    // Use registry for provider health info
    const health = getProviderHealthInfo();

    if (health.available.length === 0) {
      const missing = health.unavailable.map((p) => `${p.id} (needs ${p.missingEnv})`).join(', ');
      return Promise.resolve({
        healthy: false,
        message: `No search providers available. Missing: ${missing}`,
      });
    }

    const priorityInfo = health.configuredPriority
      ? ` (priority: ${health.configuredPriority.join(',')})`
      : '';

    return Promise.resolve({
      healthy: true,
      message: `Available: ${health.available.join(', ')}. Default: ${health.defaultProvider ?? 'none'}${priorityInfo}`,
    });
  },
};

/**
 * Get plugin tools (for manual registration if needed).
 */
export function getTools(): PluginTool[] {
  return pluginTools;
}

/**
 * The web search plugin instance.
 */
const webSearchPlugin: PluginV2 = {
  manifest,
  lifecycle,
  get tools() {
    return pluginTools;
  },
};

export default webSearchPlugin;
