import { readFile, access, mkdir, rename, open as openFile, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentConfigFile, MergedConfig } from './config-schema.js';
import { DEFAULT_CONFIG, CONFIG_FILE_VERSION } from './config-schema.js';

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

/**
 * The chain every write of every loader's file is serialized behind: the
 * settings interface saves ONE at a time, and even two direct writeFile calls
 * cannot interleave their temp-rename inodes.
 */
let writeChain: Promise<unknown> = Promise.resolve();

/**
 * Swallow one error on purpose: the temp file is already unreachable, and a
 * cleanup miss must not mask the write's own error.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-function
function ignoreRemovalFailure(): void {}

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
   * It is written atomically (a temporary file in the same directory, fsynced,
   * renamed over the target), so a crash mid-write can never leave half a
   * config behind: the file is either the old one or the new one.
   *
   * Two properties are load-bearing for lifemodel's settings interface:
   *
   * - THE TEMP FILE IS UNIQUE TO THIS WRITE (its name carries a random id),
   *   and every write is serialized behind the loader's own chain. Overlapping
   *   saves can therefore never share a temporary inode, and a failed save can
   *   never publish another save's content - its failure is reported with the
   *   file left exactly as it was.
   * - THE PATH IS A NAMED EXCEPTION TO LESSON 4 (Unified Storage Path): this
   *   file is the config loader's own, and the loader reads it back at every
   *   start. JSONStorage writes sanitized keys under the state root (neither
   *   this file's name nor its shape would survive it), and DeferredStorage
   *   would leave the write unflushed behind an answer that promises the save.
   *   So the write stays here - direct, fsynced, and awaited before the
   *   interface answers. docs/features/instance/settings.md carries the same
   *   note.
   */
  async writeFile(file: AgentConfigFile): Promise<void> {
    const run = async (): Promise<void> => {
      const target = this.filePath;
      // The config DIRECTORY may not exist yet: a first start has no
      // `data/config/` at all (the loader makes `data/`, not its subdirectories),
      // and the first save is what creates the file. Created here, by lifemodel's
      // own user, inside the data directory it owns.
      await mkdir(dirname(target), { recursive: true });
      // A name ONLY this write can hold: two saves never share an inode, so a
      // failed save cannot publish the other's content.
      const temporary = `${target}.tmp-${randomUUID()}`;
      try {
        const handle = await openFile(temporary, 'w');
        try {
          await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, 'utf-8');
          // On disk before the rename: a rename is atomic, but a power loss could
          // still publish an empty file if the data behind it was not flushed.
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          await rename(temporary, target);
        } catch (error) {
          // The rename failed: nothing was published. Remove the now-unreachable
          // temp file and let the error reach the caller.
          await unlink(temporary).catch(ignoreRemovalFailure);
          throw error;
        }
        // The directory entry itself: without this the rename can be lost too.
        const directory = await openFile(dirname(target), 'r');
        try {
          await directory.sync();
        } catch {
          // A directory that cannot be synced is not a reason to lose the write:
          // the file is in place and readable.
        } finally {
          await directory.close();
        }
      } catch (error) {
        // A failure before the rename never touched the target; remove the
        // incomplete temp file so the directory holds no half-written config.
        await unlink(temporary).catch(ignoreRemovalFailure);
        throw error;
      }
    };
    // Serialize writes through the loader itself (the settings interface
    // serializes its whole save too; this chain is what two callers that
    // bypass it still cannot defeat).
    const settled = writeChain.then(run, run);
    writeChain = settled.catch(ignoreRemovalFailure);
    await settled;
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
