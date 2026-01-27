import fs from 'node:fs';
import path from 'node:path';
import pino from 'pino';

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
 * Create a configured logger instance.
 *
 * Features:
 * - Console output with pino-pretty (in development)
 * - File output with timestamp-based filename
 * - Auto-cleanup of old and empty log files (max 10)
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
  });
}
