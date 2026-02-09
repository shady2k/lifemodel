/**
 * Task Logger — per-run human-readable log file.
 *
 * Writes to `<baseDir>/<runId>/log.txt` using appendFile for crash-safety.
 * Best-effort: IO errors are silently swallowed so logging never crashes a run.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * Per-run task logger.
 */
export class TaskLogger {
  private readonly logPath: string;
  private dirCreated = false;

  constructor(baseDir: string, runId: string) {
    const logPath = join(baseDir, runId, 'log.txt');
    const resolved = resolve(logPath);
    const resolvedBase = resolve(baseDir) + sep;
    if (!resolved.startsWith(resolvedBase)) {
      // Path traversal attempt — disable logging for this run
      this.logPath = '';
    } else {
      this.logPath = resolved;
    }
  }

  /**
   * Append a timestamped line to the log (best-effort, never throws).
   */
  async log(line: string): Promise<void> {
    if (!this.logPath) return; // Disabled (path traversal guard)
    try {
      if (!this.dirCreated) {
        await mkdir(dirname(this.logPath), { recursive: true });
        this.dirCreated = true;
      }
      const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
      await appendFile(this.logPath, `[${ts}] ${line}\n`, 'utf-8');
    } catch {
      // Best-effort: logging failure must never crash a run
    }
  }
}

/**
 * Create a task logger if artifacts base dir is configured.
 * Returns null if not configured (logging disabled).
 */
export function createTaskLogger(
  artifactsBaseDir: string | undefined,
  runId: string
): TaskLogger | null {
  if (!artifactsBaseDir) return null;
  return new TaskLogger(artifactsBaseDir, runId);
}

/**
 * Redact credential placeholders from a string for safe logging.
 */
export function redactCredentials(text: string): string {
  return text.replace(/<credential:[^>]+>/g, '<credential:***>');
}
