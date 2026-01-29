/**
 * Ports - Hexagonal Architecture Interfaces
 *
 * This module exports all port interfaces for the Clean Architecture.
 * Ports define the boundaries between the domain and infrastructure.
 *
 * Usage:
 *   import { IChannel, ILLM, IStorage } from './ports/index.js';
 *
 * Types of ports:
 * - Primary (driving): Interfaces that external actors use to drive the application
 * - Secondary (driven): Interfaces that the application uses to interact with external systems
 *
 * ┌────────────────────────────────────────────────────────────────┐
 * │                      PORTS OVERVIEW                            │
 * ├────────────────────────────────────────────────────────────────┤
 * │ IChannel    - Bidirectional messaging (Telegram, Discord)      │
 * │ IStorage    - Key-value persistence (JSON, Postgres)           │
 * │ IScheduler  - Time-based scheduling (cron, timers)             │
 * │ ILLM        - Language model completions (OpenAI, local)       │
 * │ IEmbedding  - Vector embeddings (for semantic search)          │
 * │ ILogger     - Structured logging (Pino, console)               │
 * │ IPlugin     - Plugin extensions (reminder, weather)            │
 * └────────────────────────────────────────────────────────────────┘
 */

// Channel ports
export type {
  IChannel,
  INotifier,
  ChannelSendOptions,
  InboundMessage,
  ChannelHealth,
} from './channel.js';
export { isFullChannel } from './channel.js';

// Storage ports
export type {
  IStorage,
  INamespacedStorage,
  ITransactionalStorage,
  StorageQueryOptions,
  StorageFactory,
} from './storage.js';

// Scheduler ports
export type {
  IScheduler,
  ITimer,
  ScheduleOptions,
  ScheduleEntry,
  ScheduleFiredEvent,
  RecurrencePattern,
  SchedulerFactory,
} from './scheduler.js';

// LLM ports
export type {
  ILLM,
  IEmbedding,
  LLMMessage,
  LLMTool,
  LLMToolCall,
  LLMModelRole,
  LLMJsonSchema,
  LLMResponseFormat,
  LLMCompletionRequest,
  LLMCompletionResponse,
  LLMTokenUsage,
  EmbeddingRequest,
  EmbeddingResponse,
} from './llm.js';
export { LLMPortError } from './llm.js';

// Logger ports
export type {
  ILogger,
  IStructuredLogger,
  LogContext,
  LogLevel,
  LoggerConfig,
  LoggerFactory,
} from './logger.js';
export { createNoOpLogger } from './logger.js';

// Plugin ports
export type {
  IPlugin,
  IPluginCapabilities,
  IPluginStorage,
  IPluginScheduler,
  IIntentEmitter,
  ITimezoneService,
  ISchemaRegistry,
  PluginManifest,
  PluginCapabilityName,
  PluginIntent,
  PluginSignalInput,
  PluginTool,
  PluginToolContext,
  PluginToolResult,
  PluginEvent,
  PluginLimits,
  EmitResult,
  EventSchema,
} from './plugin.js';
export { isValidPluginId } from './plugin.js';
