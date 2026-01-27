/**
 * Logger interface for dependency injection.
 *
 * This is a minimal interface that matches Pino's API,
 * allowing us to inject the logger without coupling to Pino directly.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  fatal(obj: object, msg?: string): void;
  fatal(msg: string): void;

  /** Create a child logger with additional context */
  child(bindings: Record<string, unknown>): Logger;
}
