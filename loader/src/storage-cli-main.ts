/** Standalone loader-image entry point; stage 3 also bakes this into workbench. */
import { runStorageCli } from './storage-cli.js';

process.exitCode = await runStorageCli(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
});
