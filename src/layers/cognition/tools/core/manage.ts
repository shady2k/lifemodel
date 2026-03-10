/**
 * Core Manage Tool
 *
 * List, disable, and enable plugins at runtime.
 */

import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Plugin status entry returned by the plugin manager.
 */
export interface PluginStatus {
  pluginId: string;
  name: string;
  status: 'active' | 'paused' | 'disabled' | 'config_disabled';
  required: boolean;
}

/**
 * Dependencies for manage tool.
 */
export interface ManageToolDeps {
  pluginManager: {
    listStatuses(): PluginStatus[];
  };
}

/**
 * Create the core.manage tool.
 */
export function createManageTool(deps: ManageToolDeps): Tool {
  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      description: 'Required. One of: list_plugins, disable_plugin, enable_plugin',
      required: true,
      enum: ['list_plugins', 'disable_plugin', 'enable_plugin'],
    },
    {
      name: 'pluginId',
      type: 'string',
      description: 'Plugin ID to disable or enable (required for disable_plugin/enable_plugin)',
      required: false,
    },
  ];

  return {
    name: 'core.manage',
    description:
      'Manage plugins. list_plugins shows all with status. disable_plugin/enable_plugin toggle a plugin permanently (survives restart). Required plugins cannot be disabled.',
    tags: ['plugins', 'management'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args) => {
      const action = args['action'] as string;

      if (action === 'list_plugins') {
        const plugins = deps.pluginManager.listStatuses();
        return Promise.resolve({
          success: true,
          action: 'list_plugins',
          plugins,
        });
      }

      if (action === 'disable_plugin' || action === 'enable_plugin') {
        const pluginId = args['pluginId'] as string | undefined;
        if (!pluginId) {
          return Promise.resolve({
            success: false,
            action,
            error: 'Missing required parameter: pluginId',
          });
        }

        const statuses = deps.pluginManager.listStatuses();
        const target = statuses.find((p) => p.pluginId === pluginId);
        if (!target) {
          return Promise.resolve({
            success: false,
            action,
            error: `Unknown plugin: ${pluginId}`,
            availablePlugins: statuses.map((p) => p.pluginId),
          });
        }

        if (target.required) {
          return Promise.resolve({
            success: false,
            action,
            error: `Plugin "${pluginId}" is required and cannot be ${action === 'disable_plugin' ? 'disabled' : 'enabled'}`,
          });
        }

        if (target.status === 'config_disabled') {
          return Promise.resolve({
            success: false,
            action,
            error: `Plugin "${pluginId}" is disabled by config and cannot be toggled at runtime. Update the config file to change this.`,
          });
        }

        if (
          action === 'disable_plugin' &&
          (target.status === 'paused' || target.status === 'disabled')
        ) {
          return Promise.resolve({
            success: false,
            action,
            error: `Plugin "${pluginId}" is already disabled`,
          });
        }

        if (action === 'enable_plugin' && target.status === 'active') {
          return Promise.resolve({
            success: false,
            action,
            error: `Plugin "${pluginId}" is already enabled`,
          });
        }

        return Promise.resolve({
          success: true,
          action,
          pluginId,
        });
      }

      return Promise.resolve({
        success: false,
        action,
        error: `Unknown action: ${action}. Use "list_plugins", "disable_plugin", or "enable_plugin".`,
      });
    },
  };
}
