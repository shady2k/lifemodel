import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfigFile, MergedConfig } from './config-schema.js';
import { DEFAULT_CONFIG, CONFIG_FILE_VERSION } from './config-schema.js';

/**
 * ConfigLoader - loads and merges configuration from multiple sources.
 *
 * Priority (highest wins):
 * 1. Environment variables (for secrets)
 * 2. Config file (data/config/agent.json)
 * 3. Hardcoded defaults
 */
export class ConfigLoader {
  private readonly configPath: string;
  private loadedConfig: AgentConfigFile | null = null;

  constructor(configPath = 'data/config') {
    this.configPath = configPath;
  }

  /**
   * Load and merge configuration from all sources.
   */
  async load(): Promise<MergedConfig> {
    // Load config file (if exists)
    this.loadedConfig = await this.loadConfigFile();

    // Start with defaults
    const config = this.deepClone(DEFAULT_CONFIG);

    // Merge config file values
    if (this.loadedConfig) {
      this.mergeConfigFile(config, this.loadedConfig);
    }

    // Override with environment variables
    this.mergeEnvironment(config);

    return config;
  }

  /**
   * Get the raw loaded config file (for debugging).
   */
  getLoadedConfigFile(): AgentConfigFile | null {
    return this.loadedConfig;
  }

  /**
   * Load config file from disk.
   */
  private async loadConfigFile(): Promise<AgentConfigFile | null> {
    const filePath = join(this.configPath, 'agent.json');

    try {
      await access(filePath);
      const content = await readFile(filePath, 'utf-8');
      const config = JSON.parse(content) as AgentConfigFile;

      // Version check - warn if file version is newer than supported
      if (config.version && config.version > CONFIG_FILE_VERSION) {
        // eslint-disable-next-line no-console
        console.warn(
          `Config file version (${String(config.version)}) is newer than supported (${String(CONFIG_FILE_VERSION)})`
        );
      }

      return config;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist - that's OK, use defaults
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load config file: ${message}`);
    }
  }

  /**
   * Merge config file values into the config object.
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

    // Tick rate
    if (file.tickRate) {
      config.tickRate = {
        ...config.tickRate,
        ...file.tickRate,
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
      if (file.primaryUser.telegramChatId) {
        config.primaryUser.telegramChatId = file.primaryUser.telegramChatId;
      }
    }

    // LLM
    if (file.llm) {
      if (file.llm.fastModel) {
        config.llm.fastModel = file.llm.fastModel;
      }
      if (file.llm.smartModel) {
        config.llm.smartModel = file.llm.smartModel;
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
  }

  /**
   * Override config with environment variables.
   */
  private mergeEnvironment(config: MergedConfig): void {
    // Secrets (always from env)
    const openRouterKey = process.env['OPENROUTER_API_KEY'];
    if (openRouterKey) {
      config.llm.openRouterApiKey = openRouterKey;
    }

    const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
    if (telegramToken) {
      config.telegramBotToken = telegramToken;
    }

    // Primary user chat ID (can be in env or config)
    const chatId = process.env['PRIMARY_USER_CHAT_ID'];
    if (chatId) {
      config.primaryUser.telegramChatId = chatId;
    }

    // LLM models (env overrides config)
    const fastModel = process.env['LLM_FAST_MODEL'];
    if (fastModel) {
      config.llm.fastModel = fastModel;
    }

    const smartModel = process.env['LLM_SMART_MODEL'];
    if (smartModel) {
      config.llm.smartModel = smartModel;
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
      config.paths.config = join(dataPath, 'config');
      config.paths.state = join(dataPath, 'state');
      config.paths.logs = join(dataPath, 'logs');
      config.logging.logDir = config.paths.logs;
    }
  }

  /**
   * Deep clone an object.
   */
  private deepClone<T>(obj: T): T {
    return JSON.parse(JSON.stringify(obj)) as T;
  }
}

/**
 * Factory function for creating a config loader.
 */
export function createConfigLoader(configPath?: string): ConfigLoader {
  return new ConfigLoader(configPath);
}

/**
 * Load configuration from default paths.
 * Convenience function for quick setup.
 */
export async function loadConfig(configPath?: string): Promise<MergedConfig> {
  const loader = createConfigLoader(configPath);
  return loader.load();
}
