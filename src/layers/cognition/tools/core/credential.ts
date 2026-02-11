/**
 * Core Credential Tool
 *
 * Manages credential storage for Motor Cortex skills.
 * Credentials are stored as environment variables (VAULT_<NAME>) and
 * referenced in skill arguments as <credential:name> placeholders.
 *
 * IMPORTANT: Credential values are NEVER returned in tool responses.
 * The 'list' action only returns names. Values are only used internally
 * for placeholder resolution during Motor Cortex execution.
 */

import type { CredentialStore } from '../../../../runtime/vault/credential-store.js';
import type { Tool, ToolParameter } from '../types.js';
import { validateAgainstParameters } from '../validation.js';

/**
 * Valid actions for the credential tool.
 */
const ACTION_VALUES = ['set', 'delete', 'list'] as const;

/**
 * Result from core.credential tool execution.
 */
export interface CredentialResult {
  success: boolean;
  error?: string | undefined;
  action?: 'set' | 'delete' | 'list' | undefined;
  name?: string | undefined;
  names?: string[] | undefined;
}

/**
 * Dependencies for the credential tool.
 */
export interface CredentialToolDeps {
  /** Credential store for managing credentials */
  credentialStore: CredentialStore;
}

/**
 * Create the core.credential tool.
 */
export function createCredentialTool(deps: CredentialToolDeps): Tool {
  const store: CredentialStore = deps.credentialStore;

  const parameters: ToolParameter[] = [
    {
      name: 'action',
      type: 'string',
      enum: ACTION_VALUES,
      required: true,
      description:
        'Action to perform: set (store credential), delete (remove credential), list (show all names)',
    },
    {
      name: 'name',
      type: 'string',
      required: false,
      description: 'Credential name (for set/delete). Alphanumeric + underscores only.',
    },
    {
      name: 'value',
      type: 'string',
      required: false,
      description: 'Credential value (for set action only). Never logged or returned.',
    },
  ];

  return {
    name: 'core.credential',
    maxCallsPerTurn: 3,
    description:
      'Manage credentials for Motor Cortex skills. List shows names only (values never exposed). Credentials are referenced as <credential:name> in skill arguments. IMPORTANT: Never ask users to paste API keys in chat. Tell them to set VAULT_<NAME> env var and restart instead.',
    tags: ['credentials', 'motor', 'security'],
    hasSideEffects: true,
    parameters,
    validate: (args) => validateAgainstParameters(args as Record<string, unknown>, parameters),
    execute: (args): Promise<CredentialResult> => {
      const action = args['action'] as string | undefined;
      const name = args['name'] as string | undefined;
      const value = args['value'] as string | undefined;

      // Validate action
      if (!action || !ACTION_VALUES.includes(action as (typeof ACTION_VALUES)[number])) {
        return Promise.resolve({
          success: false,
          error: `Invalid action: ${String(action)}. Must be one of: ${ACTION_VALUES.join(', ')}`,
        });
      }

      // Handle set action
      if (action === 'set') {
        if (!name) {
          return Promise.resolve({
            success: false,
            error: 'Missing required field: name (for set action)',
          });
        }
        if (!value) {
          return Promise.resolve({
            success: false,
            error: 'Missing required field: value (for set action)',
          });
        }
        // Validate name format (alphanumeric + underscores)
        if (!/^[a-zA-Z0-9_]+$/.test(name)) {
          return Promise.resolve({
            success: false,
            error: 'Invalid name format. Use alphanumeric characters and underscores only.',
          });
        }

        store.set(name, value);
        return Promise.resolve({
          success: true,
          action: 'set',
          name,
        });
      }

      // Handle delete action
      if (action === 'delete') {
        if (!name) {
          return Promise.resolve({
            success: false,
            error: 'Missing required field: name (for delete action)',
          });
        }

        const existed: boolean = store.delete(name);
        return Promise.resolve({
          success: true,
          action: 'delete',
          name,
          ...(existed ? undefined : { error: 'Credential not found (non-critical)' }),
        });
      }

      // Handle list action
      if (action === 'list') {
        const names: string[] = store.list();
        return Promise.resolve({
          success: true,
          action: 'list',
          names,
        });
      }

      // Should never reach here
      return Promise.resolve({
        success: false,
        error: 'Unknown action',
      });
    },
  };
}
