import type { AgentIdentity } from '../types/agent/identity.js';
import type { AgentState } from '../types/agent/state.js';

/**
 * Agent configuration file schema.
 *
 * This is what gets loaded from data/config/agent.json.
 * All fields are optional - defaults are used for missing values.
 */
export interface AgentConfigFile {
  /** Schema version for migrations */
  version: number;

  /** Agent identity configuration */
  identity?: {
    /** Agent's name */
    name?: string;
    /** Personality traits (0-1 scale) */
    personality?: Partial<AgentIdentity['personality']>;
    /** Core values */
    values?: string[];
    /** Hard boundaries the agent won't cross */
    boundaries?: string[];
  };

  /** Initial agent state */
  initialState?: {
    /** Starting energy (0-1) */
    energy?: number;
    /** Starting social debt (0-1) */
    socialDebt?: number;
    /** Starting task pressure (0-1) */
    taskPressure?: number;
    /** Starting curiosity (0-1) */
    curiosity?: number;
  };

  /** Tick rate configuration */
  tickRate?: {
    /** Minimum tick interval in ms */
    min?: number;
    /** Maximum tick interval in ms */
    max?: number;
    /** Base tick interval in ms */
    base?: number;
  };

  /** Contact decision configuration */
  contactDecision?: {
    /** Base threshold for contact (0-1) */
    baseThreshold?: number;
    /** Night time threshold multiplier */
    nightMultiplier?: number;
    /** Cooldown period after contact in ms */
    cooldownMs?: number;
  };

  /** Learning configuration */
  learning?: {
    /** Learning rate for contact timing weights */
    contactTimingRate?: number;
    /** Learning rate for personality weights (very slow) */
    personalityRate?: number;
    /** Learning rate for topic preferences */
    topicPreferenceRate?: number;
  };

  /** Primary user configuration */
  primaryUser?: {
    /** User's name */
    name?: string;
    /** Timezone offset from UTC in hours */
    timezoneOffset?: number;
    /** Telegram chat ID (can also be set via env var) */
    telegramChatId?: string;
  };

  /** LLM configuration */
  llm?: {
    /** Fast model for classification */
    fastModel?: string;
    /** Smart model for composition */
    smartModel?: string;
  };

  /** Logging configuration */
  logging?: {
    /** Log level */
    level?: 'debug' | 'info' | 'warn' | 'error';
    /** Enable pretty logging */
    pretty?: boolean;
  };

  /** Plugin configuration */
  plugins?: {
    /** Directory for external plugins (default: data/plugins) */
    externalDir?: string;
    /** List of plugin IDs to enable (empty = all discovered plugins) */
    enabled?: string[];
    /** List of plugin IDs to disable (takes precedence over enabled) */
    disabled?: string[];
    /** Per-plugin configuration (keyed by plugin ID) */
    configs?: Record<string, unknown>;
  };
}

/**
 * Merged application configuration.
 *
 * This is the final config after merging:
 * 1. Hardcoded defaults (lowest priority)
 * 2. Config file values
 * 3. Environment variables (highest priority for secrets)
 */
export interface MergedConfig {
  /** Agent identity */
  identity: AgentIdentity;

  /** Initial agent state */
  initialState: Partial<AgentState>;

  /** Tick rate configuration */
  tickRate: {
    min: number;
    max: number;
    base: number;
  };

  /** Contact decision configuration */
  contactDecision: {
    baseThreshold: number;
    nightMultiplier: number;
    cooldownMs: number;
  };

  /** Learning configuration */
  learning: {
    contactTimingRate: number;
    personalityRate: number;
    topicPreferenceRate: number;
  };

  /** Primary user configuration */
  primaryUser: {
    name: string | null;
    timezoneOffset: number | null;
    telegramChatId: string | null;
  };

  /** LLM configuration */
  llm: {
    openRouterApiKey: string | null;
    fastModel: string;
    smartModel: string;
    /** App name for API tracking (shows in provider dashboards) */
    appName: string;
    /** Site URL for API tracking */
    siteUrl: string | null;
    /** Local model configuration (OpenAI-compatible API) */
    local: {
      baseUrl: string | null;
      model: string | null;
      useForFast: boolean;
      useForSmart: boolean;
    };
  };

  /** Logging configuration */
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    pretty: boolean;
    logDir: string;
    maxFiles: number;
  };

  /** Telegram bot token */
  telegramBotToken: string | null;

  /** Storage paths */
  paths: {
    data: string;
    config: string;
    state: string;
    logs: string;
  };

  /** Plugin configuration */
  plugins: {
    /** Directory for external plugins */
    externalDir: string;
    /** List of plugin IDs to enable (empty = all discovered) */
    enabled: string[];
    /** List of plugin IDs to disable */
    disabled: string[];
    /** Per-plugin configuration (keyed by plugin ID) */
    configs: Record<string, unknown>;
  };
}

/**
 * Default configuration values.
 */
export const DEFAULT_CONFIG: MergedConfig = {
  identity: {
    name: 'Nika',
    gender: 'female',
    values: ['honesty', 'helpfulness', 'curiosity'],
    boundaries: ['no deception', 'no harm', 'respect privacy'],
    personality: {
      humor: 0.5,
      formality: 0.4,
      curiosity: 0.7,
      patience: 0.6,
      empathy: 0.7,
      shyness: 0.3,
      independence: 0.5,
    },
    preferences: {
      topicsOfInterest: [],
      languageStyle: 'casual',
      emojiUse: 'moderate',
    },
  },
  initialState: {
    energy: 0.8,
    socialDebt: 0.0,
    taskPressure: 0.0,
    curiosity: 0.5,
  },
  tickRate: {
    min: 1_000,
    max: 60_000,
    base: 30_000,
  },
  contactDecision: {
    baseThreshold: 0.6,
    nightMultiplier: 1.4,
    cooldownMs: 30 * 60 * 1000, // 30 minutes
  },
  learning: {
    contactTimingRate: 0.1,
    personalityRate: 0.01,
    topicPreferenceRate: 0.05,
  },
  primaryUser: {
    name: null,
    timezoneOffset: null,
    telegramChatId: null,
  },
  llm: {
    openRouterApiKey: null,
    fastModel: 'anthropic/claude-haiku-4.5',
    smartModel: 'anthropic/claude-sonnet-4.5',
    appName: 'Lifemodel',
    siteUrl: 'https://github.com/shady2k/lifemodel',
    local: {
      baseUrl: null,
      model: null,
      useForFast: true, // Default: use local for fast if configured
      useForSmart: false, // Default: use cloud for smart
    },
  },
  logging: {
    level: 'info',
    pretty: true,
    logDir: 'data/logs',
    maxFiles: 10,
  },
  telegramBotToken: null,
  paths: {
    data: 'data',
    config: 'data/config',
    state: 'data/state',
    logs: 'data/logs',
  },
  plugins: {
    externalDir: 'data/plugins',
    enabled: [], // Empty = all discovered plugins
    disabled: [],
    configs: {}, // Per-plugin configuration
  },
};

/**
 * Current config file schema version.
 */
export const CONFIG_FILE_VERSION = 1;
