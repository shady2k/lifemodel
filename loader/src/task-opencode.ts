/** OpenCode v2 configuration only. The protocol client is generic ACP. */
import { join } from 'node:path';

export function configureAgent(input: {
  workDirectory: string;
  configFile: string;
  relayBaseURL: string;
}): NodeJS.ProcessEnv {
  return {
    OPENCODE_CONFIG: input.configFile,
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      model: 'lifemodel/task',
      providers: {
        lifemodel: {
          name: 'Task gateway',
          package: '@opencode/ai/providers/openai-compatible',
          settings: { baseURL: input.relayBaseURL, apiKey: 'task-relay' },
          models: {
            task: {
              name: 'Task',
              capabilities: { tools: true, input: ['text'], output: ['text'] },
              limit: { context: 128000, output: 16000 },
              cost: { input: 0, output: 0 },
            },
          },
        },
      },
    }),
    OPENCODE_DISABLE_AUTOUPDATE: 'true',
    OPENCODE_DISABLE_MODELS_FETCH: 'true',
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
    OPENCODE_DISABLE_CLAUDE_CODE: 'true',
    OPENCODE_DISABLE_FILEWATCHER: 'true',
    OPENCODE_DISABLE_FFF: 'true',
    XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] ?? '/etc/lifemodel/xdg',
    XDG_CACHE_HOME: join(input.workDirectory, 'home/.cache'),
    XDG_DATA_HOME: join(input.workDirectory, 'home/.local/share'),
    XDG_STATE_HOME: join(input.workDirectory, 'home/.local/state'),
  };
}

/** v2's completed shell call may still carry a failed process exit. */
export function toolOutputFailed(output: unknown, input?: unknown): boolean {
  // Background commands do not carry their eventual exit in the prompt's ACP
  // terminal. Fail closed rather than claim an unobserved result succeeded.
  if (
    input &&
    typeof input === 'object' &&
    (input as Record<string, unknown>)['background'] === true
  )
    return true;
  if (!output || typeof output !== 'object') return false;
  const metadata = (output as Record<string, unknown>)['metadata'];
  if (!metadata || typeof metadata !== 'object') return false;
  const value = metadata as Record<string, unknown>;
  return (
    (Object.hasOwn(value, 'exit') && value['exit'] !== 0) ||
    Boolean(value['signal']) ||
    Boolean(value['timeout']) ||
    value['status'] === 'running'
  );
}
