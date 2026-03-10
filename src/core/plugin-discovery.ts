/**
 * Plugin Discovery
 *
 * Discovers and loads plugins from:
 * 1. Built-in plugins (dist/plugins/*)
 * 2. External plugins (configurable path, default: data/plugins/*)
 *
 * Plugin structure:
 * - Built-in: dist/plugins/{pluginId}/index.js (compiled from src/plugins/*)
 * - External: {externalDir}/{pluginId}/index.js + package.json (manifest)
 */

import { readdir, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Logger } from '../types/logger.js';
import type { PluginV2, PluginManifestV2 } from '../types/plugin.js';

/**
 * Discovered plugin info before loading.
 */
export interface DiscoveredPlugin {
  /** Plugin ID */
  id: string;

  /** Path to plugin directory */
  path: string;

  /** Whether this is a built-in plugin */
  builtIn: boolean;

  /** Manifest (from package.json for external, from module for built-in) */
  manifest?: PluginManifestV2 | undefined;
}

/**
 * Loaded plugin with its source info.
 */
export interface LoadedPluginInfo {
  /** Plugin instance */
  plugin: PluginV2;

  /** Discovery info */
  discoveryInfo: DiscoveredPlugin;
}

/**
 * Plugin discovery configuration.
 */
export interface PluginDiscoveryConfig {
  /** Directory for external plugins */
  externalDir: string;

  /** List of plugin IDs to enable (empty = all) */
  enabled: string[];

  /** List of plugin IDs to disable (takes precedence) */
  disabled: string[];
}

/**
 * Get the directory where built-in plugins are located.
 * In compiled code, this is dist/plugins relative to the module.
 */
function getBuiltInPluginsDir(): string {
  // Get the directory of this file (dist/core/)
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // Go up one level (dist/) and into plugins/
  return join(currentDir, '..', 'plugins');
}

/**
 * Discover all available plugins.
 * Note: Filtering happens AFTER loading to use manifest IDs, not folder names.
 */
export async function discoverPlugins(
  config: PluginDiscoveryConfig,
  logger: Logger
): Promise<DiscoveredPlugin[]> {
  const discovered: DiscoveredPlugin[] = [];

  // 1. Discover built-in plugins
  const builtInDir = getBuiltInPluginsDir();
  const builtInPlugins = await discoverPluginsInDir(builtInDir, true, logger);
  discovered.push(...builtInPlugins);

  // 2. Discover external plugins
  const externalPlugins = await discoverPluginsInDir(config.externalDir, false, logger);
  discovered.push(...externalPlugins);

  logger.info(
    {
      total: discovered.length,
      builtIn: builtInPlugins.length,
      external: externalPlugins.length,
    },
    'Plugin discovery complete (filtering happens after loading)'
  );

  // Note: Filtering by enabled/disabled is done in loadAllPlugins after
  // loading each plugin to get its manifest ID
  return discovered;
}

/**
 * Check if a plugin should be enabled based on config.
 * Uses manifest ID, not folder name.
 */
export function isPluginEnabled(
  manifestId: string,
  config: PluginDiscoveryConfig,
  logger: Logger
): boolean {
  // Disabled takes precedence
  if (config.disabled.includes(manifestId)) {
    logger.debug({ pluginId: manifestId }, 'Plugin disabled by config');
    return false;
  }

  // If enabled list is empty, all non-disabled plugins are enabled
  if (config.enabled.length === 0) {
    return true;
  }

  // Otherwise, only load explicitly enabled plugins
  const isEnabled = config.enabled.includes(manifestId);
  if (!isEnabled) {
    logger.debug({ pluginId: manifestId }, 'Plugin not in enabled list');
  }
  return isEnabled;
}

/**
 * Directories that look like plugins but are actually shared libraries.
 * These are excluded from plugin discovery.
 */
const SHARED_LIBRARY_DIRS = ['web-shared'] as const;

/**
 * Discover plugins in a directory.
 */
async function discoverPluginsInDir(
  dir: string,
  builtIn: boolean,
  logger: Logger
): Promise<DiscoveredPlugin[]> {
  const plugins: DiscoveredPlugin[] = [];

  try {
    await access(dir);
  } catch {
    // Directory doesn't exist - that's OK
    logger.debug({ dir, builtIn }, 'Plugin directory does not exist');
    return plugins;
  }

  try {
    const entries = await readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      // Skip shared library directories (not plugins)
      if (SHARED_LIBRARY_DIRS.includes(entry.name as (typeof SHARED_LIBRARY_DIRS)[number])) {
        logger.debug({ dir: entry.name }, 'Skipping shared library directory');
        continue;
      }

      const pluginPath = join(dir, entry.name);

      // Check for index.js (compiled) or index.ts (dev mode)
      let indexPath = join(pluginPath, 'index.js');
      try {
        await access(indexPath);
      } catch {
        // Try .ts for dev mode
        indexPath = join(pluginPath, 'index.ts');
        try {
          await access(indexPath);
        } catch {
          logger.debug({ path: pluginPath }, 'No index.js or index.ts found, skipping');
          continue;
        }
      }

      // For external plugins, read package.json for manifest
      let manifest: PluginManifestV2 | undefined;
      if (!builtIn) {
        const packagePath = join(pluginPath, 'package.json');
        try {
          const packageContent = await readFile(packagePath, 'utf-8');
          const pkg = JSON.parse(packageContent) as {
            name?: string;
            version?: string;
            lifemodel?: PluginManifestV2;
          };

          // Manifest can be in "lifemodel" field or we construct from package.json
          if (pkg.lifemodel) {
            manifest = pkg.lifemodel;
          } else {
            logger.warn(
              { path: pluginPath },
              'External plugin missing lifemodel manifest in package.json'
            );
          }
        } catch {
          logger.warn({ path: pluginPath }, 'External plugin missing or invalid package.json');
        }
      }

      // Use directory name as plugin ID for discovery
      // Final ID comes from manifest after loading
      plugins.push({
        id: entry.name,
        path: pluginPath,
        builtIn,
        manifest,
      });

      logger.debug({ pluginId: entry.name, builtIn, path: pluginPath }, 'Plugin discovered');
    }
  } catch (error) {
    logger.error(
      { dir, error: error instanceof Error ? error.message : String(error) },
      'Failed to read plugin directory'
    );
  }

  return plugins;
}

/**
 * Load a discovered plugin.
 */
export async function loadDiscoveredPlugin(
  discovered: DiscoveredPlugin,
  logger: Logger
): Promise<LoadedPluginInfo | null> {
  // Try .js first (compiled), then .ts (dev mode)
  let indexPath = join(discovered.path, 'index.js');
  try {
    await access(indexPath);
  } catch {
    indexPath = join(discovered.path, 'index.ts');
  }

  try {
    // Convert to file:// URL for dynamic import
    const moduleUrl = pathToFileURL(indexPath).href;

    // Dynamic import
    const module = (await import(moduleUrl)) as { default?: PluginV2 };

    if (!module.default) {
      logger.error({ pluginId: discovered.id }, 'Plugin module has no default export');
      return null;
    }

    const plugin = module.default;

    // Validate manifest (runtime check - manifestVersion could be wrong in invalid plugins)

    if (!plugin.manifest || (plugin.manifest.manifestVersion as number) !== 2) {
      logger.error({ pluginId: discovered.id }, 'Plugin has invalid or missing manifest');
      return null;
    }

    // Update discovered ID to match actual manifest ID
    discovered.id = plugin.manifest.id;
    discovered.manifest = plugin.manifest;

    logger.info(
      {
        pluginId: plugin.manifest.id,
        version: plugin.manifest.version,
        builtIn: discovered.builtIn,
      },
      'Plugin loaded'
    );

    return {
      plugin,
      discoveryInfo: discovered,
    };
  } catch (error) {
    logger.error(
      {
        pluginId: discovered.id,
        path: discovered.path,
        error: error instanceof Error ? error.message : String(error),
      },
      'Failed to load plugin'
    );
    return null;
  }
}

/**
 * Result from loading all plugins.
 * Separates enabled plugins (to activate) from disabled plugins (metadata only).
 */
export interface LoadAllPluginsResult {
  /** Plugins to activate (passed config + persisted disabled check) */
  enabled: LoadedPluginInfo[];
  /** Plugins disabled at runtime (can be re-enabled via core.manage) */
  runtimeDisabled: LoadedPluginInfo[];
  /** Plugins disabled by config (cannot be re-enabled at runtime) */
  configDisabled: LoadedPluginInfo[];
}

/**
 * Load all discovered plugins.
 * Dynamic-imports all plugins to get their manifests, then separates into
 * enabled (to activate) and disabled (metadata only, available for runtime re-enable).
 *
 * @param config - Discovery config with enabled/disabled lists
 * @param logger - Logger
 * @param runtimeDisabledIds - Additional plugin IDs disabled at runtime (persisted in storage)
 */
export async function loadAllPlugins(
  config: PluginDiscoveryConfig,
  logger: Logger,
  runtimeDisabledIds: ReadonlySet<string> = new Set()
): Promise<LoadAllPluginsResult> {
  const discovered = await discoverPlugins(config, logger);
  const enabled: LoadedPluginInfo[] = [];
  const runtimeDisabled: LoadedPluginInfo[] = [];
  const configDisabled: LoadedPluginInfo[] = [];

  for (const d of discovered) {
    const result = await loadDiscoveredPlugin(d, logger);
    if (!result) continue;

    const manifestId = result.plugin.manifest.id;

    // Separate config-disabled from runtime-disabled
    if (!isPluginEnabled(manifestId, config, logger)) {
      logger.info({ pluginId: manifestId }, 'Plugin imported but disabled by config');
      configDisabled.push(result);
      continue;
    }

    if (runtimeDisabledIds.has(manifestId)) {
      logger.info({ pluginId: manifestId }, 'Plugin imported but disabled at runtime');
      runtimeDisabled.push(result);
      continue;
    }

    enabled.push(result);
  }

  logger.info(
    {
      enabledPlugins: enabled.length,
      runtimeDisabled: runtimeDisabled.length,
      configDisabled: configDisabled.length,
    },
    'Plugin loading complete'
  );
  return { enabled, runtimeDisabled, configDisabled };
}
