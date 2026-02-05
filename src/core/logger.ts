import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { getTraceContext } from './trace-context.js';

/**
 * Logger configuration.
 */
export interface LoggerConfig {
  /** Directory for log files */
  logDir: string;
  /** Maximum number of log files to keep */
  maxFiles: number;
  /** Log level */
  level: pino.Level;
  /** Enable pretty printing (development) */
  pretty: boolean;
}

const DEFAULT_CONFIG: LoggerConfig = {
  logDir: './data/logs',
  maxFiles: 10,
  level: 'info',
  pretty: process.env['NODE_ENV'] !== 'production',
};

/**
 * Generate timestamp-based log filename.
 */
function generateLogFilename(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `agent-${timestamp}.log`;
}

/**
 * Cleanup old log files, keeping only the most recent maxFiles.
 * Also removes empty log files.
 */
function cleanupOldLogs(logDir: string, maxFiles: number): void {
  if (!fs.existsSync(logDir)) {
    return;
  }

  const files = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith('agent-') && f.endsWith('.log'))
    .map((f) => {
      const filePath = path.join(logDir, f);
      const stats = fs.statSync(filePath);
      return {
        name: f,
        path: filePath,
        mtime: stats.mtime.getTime(),
        size: stats.size,
      };
    });

  // Remove empty log files
  for (const file of files) {
    if (file.size === 0) {
      try {
        fs.unlinkSync(file.path);
      } catch {
        // Ignore deletion errors
      }
    }
  }

  // Get non-empty files and sort by mtime
  const nonEmptyFiles = files.filter((f) => f.size > 0).sort((a, b) => b.mtime - a.mtime); // newest first

  // Remove old files beyond maxFiles
  const filesToDelete = nonEmptyFiles.slice(maxFiles);
  for (const file of filesToDelete) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      // Ignore deletion errors
    }
  }
}

/**
 * Ensure log directory exists.
 */
function ensureLogDir(logDir: string): void {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Create Pino mixin that injects trace context.
 * Auto-injects traceId, correlationId, parentId, and spanId into ALL log entries.
 *
 * IMPORTANT: Explicit trace fields in log args take precedence over ALS values.
 * This allows developers to override trace IDs when needed.
 */
function createTraceMixin(): () => Record<string, unknown> {
  // Cache these keys to avoid repeated string allocations
  const TRACE_KEYS = ['traceId', 'correlationId', 'parentId', 'spanId'] as const;

  return () => {
    const ctx = getTraceContext();
    if (!ctx) return {};

    // Return only fields that are present in context
    // Caller-provided values will override these via Pino's merge behavior
    const result: Record<string, unknown> = {};
    for (const key of TRACE_KEYS) {
      if (ctx[key]) {
        result[key] = ctx[key];
      }
    }
    return result;
  };
}

/**
 * Create a configured logger instance.
 *
 * Features:
 * - Console output with pino-pretty (in development)
 * - File output with timestamp-based filename
 * - Auto-cleanup of old and empty log files (max 10)
 * - Auto-injection of trace context via mixin (AsyncLocalStorage)
 */
export function createLogger(config: Partial<LoggerConfig> = {}): pino.Logger {
  const finalConfig = { ...DEFAULT_CONFIG, ...config };
  const { logDir, maxFiles, level, pretty } = finalConfig;

  // Ensure log directory exists
  ensureLogDir(logDir);

  // Cleanup old and empty logs
  cleanupOldLogs(logDir, maxFiles);

  // Generate log file path
  const logFilePath = path.join(logDir, generateLogFilename());

  // Build transport targets
  const targets: pino.TransportTargetOptions[] = [];

  // Console output with pino-pretty
  if (pretty) {
    targets.push({
      target: 'pino-pretty',
      level,
      options: {
        colorize: true,
      },
    });
  } else {
    targets.push({
      target: 'pino/file',
      level,
      options: { destination: 1 }, // stdout
    });
  }

  // File output with pino-pretty
  targets.push({
    target: 'pino-pretty',
    level,
    options: {
      destination: logFilePath,
      mkdir: true,
      colorize: false,
    },
  });

  return pino({
    level,
    transport: {
      targets,
    },
    // Auto-inject trace context into ALL log entries
    mixin: createTraceMixin(),
  });
}

/**
 * Generate conversation log filename.
 */
function generateConversationLogFilename(): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `conversation-${timestamp}.log`;
}

/**
 * Create a separate logger for conversation logs.
 *
 * This creates a dedicated log file for LLM interactions (requests, responses, tool calls).
 * Uses the same pino configuration but writes to a separate file.
 *
 * @param logDir - Directory for log files
 * @param level - Log level (default: 'info')
 * @returns Logger instance for conversation logs
 */
export function createConversationLogger(
  logDir = './data/logs',
  level: pino.Level = 'info'
): pino.Logger {
  // Ensure log directory exists
  ensureLogDir(logDir);

  // Cleanup old conversation logs
  const maxFiles = 10;
  const conversationFiles = fs
    .readdirSync(logDir)
    .filter((f) => f.startsWith('conversation-') && f.endsWith('.log'))
    .map((f) => {
      const filePath = path.join(logDir, f);
      const stats = fs.statSync(filePath);
      return { name: f, path: filePath, mtime: stats.mtime.getTime(), size: stats.size };
    })
    .filter((f) => f.size > 0)
    .sort((a, b) => b.mtime - a.mtime);

  for (const file of conversationFiles.slice(maxFiles)) {
    try {
      fs.unlinkSync(file.path);
    } catch {
      // Ignore errors
    }
  }

  // Generate conversation log file path
  const conversationLogPath = path.join(logDir, generateConversationLogFilename());

  // Create a write stream for plain text output
  const logStream = fs.createWriteStream(conversationLogPath, { flags: 'a' });

  // Custom destination: timestamp + trace context + message (no level, no JSON noise)
  // Trace context (traceId, spanId) allows correlation with main agent log
  const destination = {
    write(chunk: string): void {
      try {
        const parsed = JSON.parse(chunk) as {
          msg?: string;
          time?: number;
          traceId?: string;
          spanId?: string;
        };
        if (parsed.msg) {
          const timestamp = parsed.time
            ? new Date(parsed.time).toISOString().slice(11, 23) // HH:mm:ss.mmm
            : '';
          // Build prefix: [timestamp] [traceId:spanId] or just [timestamp]
          let prefix = timestamp ? `[${timestamp}] ` : '';
          if (parsed.traceId || parsed.spanId) {
            const traceShort = parsed.traceId?.slice(0, 8) ?? '????????';
            const spanShort = parsed.spanId ?? '?';
            prefix += `[${traceShort}:${spanShort}] `;
          }
          logStream.write(prefix + parsed.msg + '\n');
        }
      } catch {
        // If not JSON, write as-is
        logStream.write(chunk);
      }
    },
  };

  // Use mixin to auto-inject trace context (traceId, spanId) from AsyncLocalStorage
  return pino({ level, mixin: createTraceMixin() }, destination);
}

/**
 * Global conversation logger instance.
 * Set by container and accessible throughout the app.
 */
let globalConversationLogger: pino.Logger | null = null;

/**
 * Set the global conversation logger.
 * Called by container during initialization.
 */
export function setConversationLogger(logger: pino.Logger): void {
  globalConversationLogger = logger;
}

/**
 * Get the global conversation logger.
 * Returns null if not yet initialized.
 */
export function getConversationLogger(): pino.Logger | null {
  return globalConversationLogger;
}

/**
 * Log to the conversation log.
 * Convenience function that's safe to call even if conversation logger isn't initialized.
 */
export function logConversation(obj: unknown, msg: string, ...args: unknown[]): void {
  globalConversationLogger?.info(obj, msg, ...args);
}
