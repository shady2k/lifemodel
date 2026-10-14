import type { Pool } from 'pg';
import type { AgentConfigFile, MergedConfig } from './config-schema.js';
import { DEFAULT_CONFIG } from './config-schema.js';
import { PostgresConfigStore } from './postgres-config-store.js';
import type { Logger } from '../types/logger.js';
import { join } from 'node:path';

export interface ConfigStore {
  read(): Promise<AgentConfigFile | null>;
  write(document: AgentConfigFile): Promise<void>;
}

/** Reads and writes the one configuration document in Postgres. */
export class ConfigLoader {
  private loadedConfig: AgentConfigFile | null = null;
  private readonly store: ConfigStore;

  constructor(source: Pool | ConfigStore, _logger?: Logger) {
    this.store = isPool(source) ? new PostgresConfigStore(source) : source;
  }

  async load(): Promise<MergedConfig> {
    this.loadedConfig = await this.store.read();
    const config = this.deepClone(DEFAULT_CONFIG);
    if (this.loadedConfig) this.mergeConfigFile(config, this.loadedConfig);
    this.mergeEnvironment(config);
    return config;
  }

  getLoadedConfig(): AgentConfigFile | null {
    return this.loadedConfig;
  }

  async readConfig(): Promise<AgentConfigFile | null> {
    return await this.store.read();
  }

  async writeConfig(file: AgentConfigFile, options?: { signal?: AbortSignal }): Promise<void> {
    options?.signal?.throwIfAborted();
    await this.store.write(file);
  }

  /**
   * Merge saved configuration values into the config object.
   */
  private mergeConfigFile(config: MergedConfig, file: AgentConfigFile): void {
    // Identity
    if (file.identity) {
      if (file.identity.name) {
        config.identity.name = file.identity.name;
      }
      if (file.identity.values) {
        config.identity.values = file.identity.values;
      }
      if (file.identity.boundaries) {
        config.identity.boundaries = file.identity.boundaries;
      }
      if (file.identity.personality) {
        config.identity.personality = {
          ...config.identity.personality,
          ...file.identity.personality,
        };
      }
    }

    // Initial state
    if (file.initialState) {
      config.initialState = {
        ...config.initialState,
        ...file.initialState,
      };
    }

    // Contact decision
    if (file.contactDecision) {
      config.contactDecision = {
        ...config.contactDecision,
        ...file.contactDecision,
      };
    }

    // Learning
    if (file.learning) {
      config.learning = {
        ...config.learning,
        ...file.learning,
      };
    }

    // Primary user
    if (file.primaryUser) {
      if (file.primaryUser.name) {
        config.primaryUser.name = file.primaryUser.name;
      }
      if (file.primaryUser.timezoneOffset !== undefined) {
        config.primaryUser.timezoneOffset = file.primaryUser.timezoneOffset;
      }
    }

    // LLM
    if (file.llm) {
      // The endpoint: each field on its own, so a half-written one is visible
      // as half-written rather than merged away (lifemodel-q4x.4.1).
      if (file.llm.endpoint) {
        const endpoint = file.llm.endpoint;
        if (endpoint.baseUrl !== undefined) config.llm.endpoint.baseUrl = endpoint.baseUrl;
        if (endpoint.fastModel !== undefined) config.llm.endpoint.fastModel = endpoint.fastModel;
        if (endpoint.smartModel !== undefined) config.llm.endpoint.smartModel = endpoint.smartModel;
        if (endpoint.motorModel !== undefined) config.llm.endpoint.motorModel = endpoint.motorModel;
      }
    }

    // Logging
    if (file.logging) {
      if (file.logging.level) {
        config.logging.level = file.logging.level;
      }
      if (file.logging.pretty !== undefined) {
        config.logging.pretty = file.logging.pretty;
      }
    }

    // Motor Cortex
    if (file.motorCortex?.enabled !== undefined) {
      config.motorCortex.enabled = file.motorCortex.enabled;
    }

    // Plugins
    if (file.plugins) {
      if (file.plugins.externalDir) {
        config.plugins.externalDir = file.plugins.externalDir;
      }
      if (file.plugins.enabled) {
        config.plugins.enabled = file.plugins.enabled;
      }
      if (file.plugins.disabled) {
        config.plugins.disabled = file.plugins.disabled;
      }
      if (file.plugins.configs) {
        config.plugins.configs = file.plugins.configs;
      }
    }
  }

  /**
   * Override config with environment variables.
   */
  private mergeEnvironment(config: MergedConfig): void {
    // The endpoint (each field on its own: an environment variable names one
    // field, and a half-written endpoint stays visible as one)
    const endpointBaseUrl = process.env['LLM_ENDPOINT_BASE_URL'];
    if (endpointBaseUrl !== undefined) {
      config.llm.endpoint.baseUrl = endpointBaseUrl;
    }

    const endpointFastModel = process.env['LLM_ENDPOINT_FAST_MODEL'];
    if (endpointFastModel !== undefined) {
      config.llm.endpoint.fastModel = endpointFastModel;
    }

    const endpointSmartModel = process.env['LLM_ENDPOINT_SMART_MODEL'];
    if (endpointSmartModel !== undefined) {
      config.llm.endpoint.smartModel = endpointSmartModel;
    }

    const endpointMotorModel = process.env['LLM_ENDPOINT_MOTOR_MODEL'];
    if (endpointMotorModel !== undefined) {
      config.llm.endpoint.motorModel = endpointMotorModel;
    }

    // Motor Cortex is an explicit boolean switch; reject misspellings rather than
    // silently enabling code execution.
    const motorCortexEnabled = process.env['MOTOR_CORTEX_ENABLED'];
    if (motorCortexEnabled !== undefined) {
      if (motorCortexEnabled !== 'true' && motorCortexEnabled !== 'false') {
        throw new Error('MOTOR_CORTEX_ENABLED must be exactly true or false');
      }
      config.motorCortex.enabled = motorCortexEnabled === 'true';
    }

    // Log level
    const logLevel = process.env['LOG_LEVEL'];
    if (logLevel && ['debug', 'info', 'warn', 'error'].includes(logLevel)) {
      config.logging.level = logLevel as MergedConfig['logging']['level'];
    }

    // Data paths
    const dataPath = process.env['DATA_PATH'];
    if (dataPath) {
      config.paths.data = dataPath;
      config.paths.state = join(dataPath, 'state');
      config.paths.logs = join(dataPath, 'logs');
      config.logging.logDir = config.paths.logs;
      config.plugins.externalDir = join(dataPath, 'plugins');
    }

    // Plugins (env override)
    const pluginsDir = process.env['PLUGINS_DIR'];
    if (pluginsDir) {
      config.plugins.externalDir = pluginsDir;
    }

    const pluginsEnabled = process.env['PLUGINS_ENABLED'];
    if (pluginsEnabled) {
      config.plugins.enabled = pluginsEnabled.split(',').map((s) => s.trim());
    }

    const pluginsDisabled = process.env['PLUGINS_DISABLED'];
    if (pluginsDisabled) {
      config.plugins.disabled = pluginsDisabled.split(',').map((s) => s.trim());
    }
  }

  /**
   * Deep clone an object.
   */
  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
  }
}

function isPool(source: Pool | ConfigStore): source is Pool {
  return 'query' in source;
}

export function createConfigLoader(source: Pool | ConfigStore, logger?: Logger): ConfigLoader {
  return new ConfigLoader(source, logger);
}

export async function loadConfig(source: Pool | ConfigStore): Promise<MergedConfig> {
  return await createConfigLoader(source).load();
}
