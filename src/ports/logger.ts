/**
 * Logger Port - Hexagonal Architecture
 *
 * Defines the interface for logging.
 * Logger adapters implement this port (Pino, Winston, console, etc.).
 *
 * Design matches Pino's API for easy adoption.
 */

/**
 * Log context - additional data attached to log entries.
 */
export type LogContext = Record<string, unknown>;

/**
 * Log level.
 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * ILogger - Primary logging port.
 *
 * Mirrors Pino's API for compatibility.
 * Supports both (context, message) and (message) signatures.
 */
export interface ILogger {
  /** Log at trace level (most verbose) */
  trace(obj: LogContext, msg?: string): void;
  trace(msg: string): void;

  /** Log at debug level */
  debug(obj: LogContext, msg?: string): void;
  debug(msg: string): void;

  /** Log at info level */
  info(obj: LogContext, msg?: string): void;
  info(msg: string): void;

  /** Log at warn level */
  warn(obj: LogContext, msg?: string): void;
  warn(msg: string): void;

  /** Log at error level */
  error(obj: LogContext, msg?: string): void;
  error(msg: string): void;

  /** Log at fatal level (most severe) */
  fatal(obj: LogContext, msg?: string): void;
  fatal(msg: string): void;

  /**
   * Create a child logger with additional context.
   * Child context is merged with parent context on each log.
   */
  child(bindings: LogContext): ILogger;

  /**
   * Get current log level (optional).
   */
  level?: string;

  /**
   * Check if a level is enabled (optional).
   */
  isLevelEnabled?(level: LogLevel): boolean;
}

/**
 * IStructuredLogger - Logger with explicit structured data support.
 *
 * For cases where you want to ensure logs are always structured.
 */
export interface IStructuredLogger {
  /**
   * Log with explicit level, context, and message.
   */
  log(level: LogLevel, context: LogContext, message: string): void;

  /**
   * Create a child logger.
   */
  child(bindings: LogContext): IStructuredLogger;
}

/**
 * Logger configuration.
 */
export interface LoggerConfig {
  /** Minimum level to log */
  level: LogLevel;
  /** Whether to pretty-print logs (development) */
  pretty?: boolean;
  /** Default context to include in all logs */
  defaultContext?: LogContext;
}

/**
 * Factory for creating loggers.
 */
export type LoggerFactory = (name: string, config?: Partial<LoggerConfig>) => ILogger;

/**
 * Create a no-op logger (for testing or disabling logs).
 */
export function createNoOpLogger(): ILogger {
  const noop = (): void => {
    /* intentionally empty */
  };
  const noopLogger: ILogger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => noopLogger,
  };
  return noopLogger;
}
