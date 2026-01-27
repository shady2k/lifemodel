/**
 * Config module exports.
 */

export type { AgentConfigFile, MergedConfig } from './config-schema.js';
export { DEFAULT_CONFIG, CONFIG_FILE_VERSION } from './config-schema.js';
export { ConfigLoader, createConfigLoader, loadConfig } from './config-loader.js';
