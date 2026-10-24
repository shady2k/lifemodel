import { describe, expect, it } from 'vitest';
import {
  agentRegistry,
  testAgentRegistry,
  agentProvisionScript,
  agentArtifacts,
  agentInstallScript,
} from '../../scripts/task-agent-provision.mjs';
import { readFileSync } from 'node:fs';

describe('registry-owned build and test provisioning', () => {
  it('uses each architecture pin and agent-owned extraction/config inputs without a second list', () => {
    for (const arch of ['x86_64', 'aarch64']) {
      const script = agentProvisionScript(arch);
      for (const [name, agent] of Object.entries(agentRegistry) as [string, any][]) {
        const spec = agent.provision.archives[arch];
        expect(script).toContain(spec.url);
        expect(script).toContain(spec.sha256);
        expect(script).toContain(agent.provision.archiveMember);
        expect(script).toContain(agent.command);
        expect(agentArtifacts()[`agent-${name}`][arch]).toEqual(spec);
        for (const file of agent.provision.files) {
          expect(script).toContain(file.source);
          expect(file.source).toMatch(/^docker\/workbench\/[^/]+\.json$/);
        }
      }
    }
    expect(() => agentProvisionScript('unsupported')).toThrow('no pinned agent archive');
  });
  it('changes the normal build input when a registry pin changes', () => {
    const registry = structuredClone(agentRegistry);
    const name = Object.keys(registry)[0]!;
    registry[name].provision.archives.x86_64.url = 'https://example.invalid/distinct-agent.tgz';
    registry[name].provision.archives.x86_64.sha256 = 'a'.repeat(64);
    const script = agentProvisionScript('x86_64', registry);
    expect(script).toContain('https://example.invalid/distinct-agent.tgz');
    expect(script).toContain('a'.repeat(64));
    expect(script).not.toBe(agentProvisionScript('x86_64'));
  });
  it('provisions the distinct scripted configuration through the same path without OpenCode config', () => {
    const agent = testAgentRegistry.scripted;
    const script = agentInstallScript('scripted', agent, undefined, '/snapshot');
    expect(script).toContain('/snapshot/tests/fixtures/task-scripted-acp.py');
    expect(script).toContain(agent.command);
    expect(script).toContain(agent.configFile);
    expect(script).not.toMatch(/opencode/i);
    expect(agentProvisionScript('x86_64', testAgentRegistry, '/snapshot')).toContain(script);
    expect(readFileSync('tests/integration/task-harness-contract.test.ts', 'utf8')).not.toContain(
      "{ configFile: join(directory, 'opencode.json') }"
    );
  });
});
