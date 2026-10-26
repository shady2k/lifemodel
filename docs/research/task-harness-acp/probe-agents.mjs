/** Pinned candidate launch configuration. No owner environment is inherited. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const CANDIDATES = {
  goose: {
    label: 'goose', command: '/opt/probe/goose/goose', args: ['acp'],
    configure: ({ relayBaseURL, workDirectory, scenario }) => ({
      GOOSE_DISABLE_KEYRING: '1', GOOSE_MODE: scenario.startsWith('permission') ? 'approve' : 'auto',
      GOOSE_PROVIDER: 'openai', GOOSE_MODEL: 'task',
      OPENAI_BASE_URL: relayBaseURL, OPENAI_BASE_PATH: 'v1/chat/completions',
      OPENAI_API_KEY: 'probe-placeholder', GOOSE_DISABLE_SESSION_NAMING: 'true',
      GOOSE_TELEMETRY_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
    }),
  },
  'prime-agent': {
    label: 'prime-agent', command: '/opt/probe/prime-agent/prime-agent',
    args: ['--mode', 'acp', '--offline', '--no-session', '--provider', 'probe', '--model', 'task'],
    configure: ({ relayBaseURL, workDirectory }) => {
      const dir = join(workDirectory, 'home/.prime/agent');
      mkdirSync(dir, {recursive:true});
      writeFileSync(join(dir, 'models.json'), JSON.stringify({providers:{probe:{baseUrl:relayBaseURL,
        api:'openai-completions',apiKey:'probe-placeholder',models:[{id:'task',name:'Probe',contextWindow:32768,maxTokens:4096}]}}}));
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({defaultProvider:'probe',defaultModel:'task',
        telemetry:{enabled:false},traces:{enabled:false}}));
      return { PI_OFFLINE:'1', DO_NOT_TRACK:'1', PRIME_AGENT_TELEMETRY:'0', PRIME_AGENT_DAEMON_SOCKET:join(workDirectory,'tmp/daemon.sock'), PRIME_AGENT_KERNEL_PYTHON:'/opt/probe/python/bin/python',
        PRIME_AGENT_CODING_AGENT_DIR:dir, PRIME_AGENT_SESSION_DIR:join(dir,'sessions') };
    },
  },
};
