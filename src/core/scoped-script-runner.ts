/**
 * Scoped Script Runner
 *
 * Creates a ScriptRunnerPrimitive that gates script execution to
 * only scripts listed in a plugin's manifest.allowedScripts.
 *
 * Plugin isolation: plugins never import runtime types directly.
 * This module bridges the gap between MotorCortex.executeScript()
 * and the PluginScriptRunResult type using structural compatibility.
 */

import type { ScriptRunnerPrimitive, PluginScriptRunResult } from '../types/plugin.js';

/**
 * Interface for the executor — matches MotorCortex.executeScript() signature.
 * Defined as interface to avoid importing the MotorCortex class directly.
 */
export interface ScriptExecutor {
  executeScript(request: {
    task: string;
    scriptId: string;
    inputs: Record<string, unknown>;
    timeoutMs?: number | undefined;
  }): Promise<{
    ok: boolean;
    runId: string;
    output?: unknown;
    error?: { code: string; message: string } | undefined;
    stats: { durationMs: number; exitCode: number | undefined };
  }>;
}

/**
 * Interface for looking up a plugin's allowed scripts.
 */
export interface AllowedScriptsLookup {
  getAllowedScripts(pluginId: string): string[];
}

/**
 * Create a ScriptRunnerPrimitive scoped to a specific plugin.
 *
 * Only scripts listed in the plugin's manifest.allowedScripts are permitted.
 * Returns SCRIPT_NOT_FOUND error for unlisted scripts.
 */
export function createScopedScriptRunner(
  executor: ScriptExecutor,
  pluginId: string,
  lookup: AllowedScriptsLookup
): ScriptRunnerPrimitive {
  return {
    async runScript(request): Promise<PluginScriptRunResult> {
      const allowedScripts = lookup.getAllowedScripts(pluginId);

      if (!allowedScripts.includes(request.scriptId)) {
        return {
          ok: false,
          runId: '',
          error: {
            code: 'SCRIPT_NOT_FOUND',
            message: `Plugin "${pluginId}" is not allowed to run script "${request.scriptId}". Allowed: [${allowedScripts.join(', ')}]`,
          },
          stats: { durationMs: 0, exitCode: undefined },
        };
      }

      return executor.executeScript({
        task: `${pluginId}:${request.scriptId}`,
        scriptId: request.scriptId,
        inputs: request.inputs ?? {},
        timeoutMs: request.timeoutMs,
      });
    },
  };
}
