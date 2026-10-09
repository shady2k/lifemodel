import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentConfigFile, MergedConfig } from './config-schema.js';
import { DEFAULT_CONFIG, CONFIG_FILE_VERSION } from './config-schema.js';
import { DeferredStorage } from '../storage/deferred-storage.js';
import { JSONStorage } from '../storage/json-storage.js';
import type { StorageSaveOptions } from '../storage/storage.js';
import type { Logger } from '../types/logger.js';

/**
 * Where lifemodel's config file lives (lifemodel-q4x.4.1).
 *
 * `DATA_PATH` moves the config with the rest of the instance's data: the loader
 * gives lifemodel `DATA_PATH=<volume>/data`, so the file is
 * `<volume>/data/config/agent.json` - the path the volume layout names. Without
 * `DATA_PATH` (a checkout, a test) it is the working directory's `data/config`.
 * One function, so the reader at startup and the writer of lifemodel's settings
 * interface can never disagree about which file it is.
 */
export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const dataPath = env['DATA_PATH'];
  return dataPath ? join(dataPath, 'config') : 'data/config';
}

/** The storage key of the config file under its own directory: `agent.json`. */
const CONFIG_STORAGE_KEY = 'agent';

/**
 * The loader has no logger of its own: a write failure is reported by CALLING
 * code (the settings interface answers 500 with it). This one stays silent so
 * a bare `createConfigLoader()` still works.
 */
const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

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
  /**
   * The REQUIRED write pipeline at the config root (AGENTS.md, Lesson 4):
   * DeferredStorage over JSONStorage, and `flush()` is the awaited durability
   * point. `createBackup: false` keeps the config loader the only writer of
   * `agent.json`'s history (no `.backup.json` sibling of the config file).
   */
  private readonly storage: DeferredStorage;

  constructor(configPath = 'data/config', logger?: Logger) {
    this.configPath = configPath;
    this.storage = new DeferredStorage(
      new JSONStorage({ basePath: configPath, createBackup: false }),
      logger ?? silentLogger
    );
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
   * The file this loader reads: `<configPath>/agent.json`.
   */
  get filePath(): string {
    return join(this.configPath, 'agent.json');
  }

  /**
   * Read the config file as it is on disk, without merging anything:
   * lifemodel's settings interface renders what the owner saved.
   */
  async readFile(): Promise<AgentConfigFile | null> {
    return await this.loadConfigFile();
  }

  /**
   * Write the config file - the SAME file `load()` reads at startup.
   *
   * The write runs through the REQUIRED storage pipeline (AGENTS.md, Lesson 4):
   * DeferredStorage, flushed through JSONStorage rooted at the config
   * directory. The key `agent` maps to `<config dir>/agent.json` with the
   * object serialized as `JSON.stringify(object, null, 2)` - the file's name
   * and the object's shape are unchanged, and the save is atomic (a temp file
   * unique to this write, fsynced, renamed over the target by
   * `JSONStorage.save`, whose publication point is that one rename).
   *
   * Awaiting `flush()` here is what makes the write's outcome DECIDED before
   * the promise resolves: either the rename published and this promise
   * resolves with the file whole on disk, or nothing was published and it
   * rejects - there is no third state (review round 2, findings B and C: the
   * old direct writer rejected AFTER its rename on a directory-sync failure,
   * reporting as unmutated a file that already held the new settings).
   *
   * The optional `signal` (a caller's stop contract) aborts the write at its
   * publication point: an aborted write never renames, and the file is left
   * exactly as it was.
   */
  async writeFile(file: AgentConfigFile, options?: StorageSaveOptions): Promise<void> {
    // Mark dirty through the deferred layer, then flush BELOW: the write's
    // outcome is decided when flush() resolves (nothing persisted, or the
    // file whole on disk).
    await this.storage.save(CONFIG_STORAGE_KEY, file);
    await this.storage.flush(options);
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
      // Provide helpful error for malformed JSON
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid JSON in config file ${filePath}: ${error.message}`);
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

    // Telegram bot token: the config file carries the Agent Vault PLACEHOLDER
    // (`__telegram_bot_token__`), never the token (lifemodel-q4x.3.*).
    if (file.telegram?.botToken) {
      config.telegramBotToken = file.telegram.botToken;
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
    // Secrets (always from env)
    const telegramToken = process.env['TELEGRAM_BOT_TOKEN'];
    if (telegramToken) {
      config.telegramBotToken = telegramToken;
    }

    // Primary user chat ID (can be in env or config)
    const chatId = process.env['PRIMARY_USER_CHAT_ID'];
    if (chatId) {
      config.primaryUser.telegramChatId = chatId;
    }

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
