#!/usr/bin/env node
/** Inline trusted build-time filenames so a missing runtime file is still named.
 * Never derive diagnostic names from a task environment or a runtime directory.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

if (!process.argv[2] || process.argv.length > 4) throw new Error('task_start_manifest_arguments');
const loaderRoot = resolve(process.argv[2]);
const source = join(loaderRoot, 'src');
const ports = resolve(loaderRoot, '../src/ports');
const target = process.argv[3] ? resolve(process.argv[3]) : join(loaderRoot, 'dist/task-launcher-main.js');

function sourceModules(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.isDirectory()) return sourceModules(join(directory, entry.name));
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) return [];
    return [entry.name.replace(/\.ts$/, '.js')];
  });
}
// Inventory inputs are checkout/build-context sources, before any image omission.
// Shared pure JS/JSON modules are copied separately from the compiled loader.
const names = [...new Set([
  ...sourceModules(source),
  ...readdirSync(ports, { withFileTypes: true })
    .filter(entry => entry.isFile() && /\.(?:mjs|json)$/.test(entry.name))
    .map(entry => entry.name),
])].sort();
if (names.some(name => name !== basename(name) || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(name))) {
  throw new Error('task_start_manifest_filename');
}
const marker = '/* task-start-module-manifest */ []';
const emitted = readFileSync(target, 'utf8');
if (emitted.split(marker).length !== 2) throw new Error('task_start_manifest_marker');
writeFileSync(target, emitted.replace(marker, JSON.stringify(names)), 'utf8');
