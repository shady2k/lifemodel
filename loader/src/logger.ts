/**
 * The loader's log (lifemodel-q4x.2.1).
 *
 * One JSON line per event on stdout - the container's log - always carrying
 * `component=loader`, so a person reading `docker logs` can tell the loader's
 * lines from lifemodel's. Secrets never reach it: nothing here formats a
 * password or a session token.
 */
export type LogFields = Record<string, unknown>;

export interface LoaderLogger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

/** A logger that writes JSON lines through `write` (stdout in the container). */
export function createStdoutLogger(write: (line: string) => void): LoaderLogger {
  const emit = (level: 'info' | 'warn' | 'error') => (fields: LogFields, message: string) => {
    write(
      JSON.stringify({
        time: new Date().toISOString(),
        level,
        component: 'loader',
        msg: message,
        ...fields,
      })
    );
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** A logger that keeps what it was told, for tests. */
export interface RecordedLine {
  level: 'info' | 'warn' | 'error';
  fields: LogFields;
  message: string;
}

export function createRecordingLogger(lines: RecordedLine[]): LoaderLogger {
  const emit = (level: 'info' | 'warn' | 'error') => (fields: LogFields, message: string) => {
    lines.push({ level, fields, message });
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}
