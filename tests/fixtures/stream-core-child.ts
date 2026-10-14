import { createContainerAsync } from '../../src/core/container.js';

const baseUrl = process.env['TEST_LLM_BASE_URL'];
const dataPath = process.env['DATA_PATH'];
if (!baseUrl || !dataPath) throw new Error('TEST_LLM_BASE_URL and DATA_PATH are required');
process.env.DATA_PATH = dataPath;

const container = await createContainerAsync({
  logToFile: false,
  logLevel: 'error',
  prettyLogs: false,
  llm: { endpoint: { baseUrl, fastModel: 'stub', smartModel: 'stub', motorModel: 'stub' } },
  coreLoop: { tickInterval: 25 },
});
container.coreLoop.start();
process.stdout.write('CORE_READY\n');
