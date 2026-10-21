/** Standalone loader-image entry point; stage 3 also bakes this into workbench. */
import { runStorageCli } from './storage-cli.js';

const OUTPUT_DEADLINE_MS = 1_000;
let outputFailed = false;

/** Keep the error listener through teardown: EPIPE can follow the write callback. */
function output(stream: NodeJS.WriteStream): (text: string) => Promise<void> {
  let failed = false;
  let failPending: (() => void) | undefined;
  stream.on('error', () => {
    failed = true;
    outputFailed = true;
    process.exitCode = 1;
    stream.destroy();
    failPending?.();
  });
  return (text) =>
    new Promise<void>((resolve, reject) => {
      if (failed || stream.destroyed) {
        outputFailed = true;
        reject(new Error('output_failed'));
        return;
      }
      let settled = false;
      const finish = (failure: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        failPending = undefined;
        if (failure) {
          failed = true;
          outputFailed = true;
          // Release a blocked pipe handle; do not attempt to print its failure here.
          stream.destroy();
          reject(new Error('output_failed'));
        } else resolve();
      };
      // A referenced deadline keeps the awaited write alive, but never beyond its bound.
      const timer = setTimeout(() => {
        finish(true);
      }, OUTPUT_DEADLINE_MS);
      failPending = () => {
        finish(true);
      };
      try {
        stream.write(text, (error) => {
          finish(Boolean(error));
        });
      } catch {
        finish(true);
      }
    });
}

// Install both listeners before either stream can be written, including error output.
const stdout = output(process.stdout);
const stderr = output(process.stderr);
const status = await runStorageCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout,
  stderr,
});
process.exitCode = outputFailed ? 1 : status;
