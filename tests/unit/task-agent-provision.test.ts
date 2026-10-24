import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateAgentRegistry } from '../../src/ports/task-agent-validation.mjs';
import { ensureArtifacts, PINNED, buildPlan, createOrbInvoker } from '../../scripts/test-docker-isolated.mjs';
import {
  agentRegistry,
  agentSourceFiles,
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

describe('registry rejection before host I/O', () => {
  const cases: [string, (agent: any) => void][] = [
    ['traversal source', agent => { agent.provision.files[0].source = '../../../owner-secret'; }],
    ['absolute source', agent => { agent.provision.files[0].source = '/owner-secret'; }],
    ['traversal archive file', agent => { agent.provision.archives.x86_64.file = '../../../../.ssh/authorized_keys'; }],
    ['HTTP URL', agent => { agent.provision.archives.x86_64.url = 'http://example.test/agent.tgz'; }],
    ['bad digest', agent => { agent.provision.archives.x86_64.sha256 = 'abc'; }],
    ['setuid mode', agent => { agent.provision.files[0].mode = '4755'; }],
    ['world-writable mode', agent => { agent.provision.files[0].mode = '0777'; }],
    ['writable mode', agent => { agent.provision.files[0].mode = '0644'; }],
    ['destination outside prefix', agent => { agent.provision.files[0].destination = '/root/.ssh/authorized_keys'; }],
    ['destination traversal', agent => { agent.provision.files[0].destination = '/etc/lifemodel/../../root/secret'; }],
    ['command outside prefix', agent => { agent.command = '/bin/sh'; }],
    ['directory outside prefix', agent => { agent.provision.directories = ['/root']; }],
    ['absolute archive member', agent => { agent.provision.archiveMember = '/root/secret'; }],
    ['traversal archive member', agent => { agent.provision.archiveMember = 'package/../secret'; }],
    ['NUL archive member', agent => { agent.provision.archiveMember = 'package/\0secret'; }],
    ['tar-option member', agent => { agent.provision.archiveMember = '--checkpoint=1'; }],
    ['fixture source in shipped registry', agent => { agent.provision.files[0].source = 'tests/fixtures/task-scripted-acp.py'; }],
  ];
  it.each(cases)('rejects %s before source reads, copies or script generation', (_label, mutate) => {
    const registry = structuredClone(agentRegistry);
    mutate(Object.values(registry)[0]);
    const read = vi.spyOn(fs, 'readFileSync');
    const realpath = vi.spyOn(fs, 'realpathSync');
    const copy = vi.fn();
    try {
      expect(() => agentSourceFiles('/unused-snapshot', registry).forEach(copy)).toThrow(/invalid task agent registry/);
      expect(() => agentProvisionScript('x86_64', registry)).toThrow(/invalid task agent registry/);
      expect(() => agentArtifacts(registry)).toThrow(/invalid task agent registry/);
      expect(() => validateAgentRegistry(registry)).toThrow(/invalid task agent registry/);
      expect(copy).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it('rejects unsafe names and fixture sources before resolving or reading a source', () => {
    const fixture = structuredClone(testAgentRegistry.scripted);
    const registry = { '../scripted': fixture };
    expect(() => agentProvisionScript('x86_64', registry)).toThrow(/agent name/);
    fixture.provision.files[0].source = 'tests/fixtures/../../../owner-secret';
    const read = vi.spyOn(fs, 'readFileSync');
    const realpath = vi.spyOn(fs, 'realpathSync');
    try {
      expect(() => agentSourceFiles('/unused', { scripted: fixture })).toThrow(/file source/);
      expect(() => agentInstallScript('scripted', fixture)).toThrow(/file source/);
      expect(read).not.toHaveBeenCalled();
      expect(realpath).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it.each(['file', 'parent'])('rejects a %s symlink escape before reading or copying the outside canary', kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-source-'));
    const snapshot = path.join(root, 'source');
    const canary = path.join(root, 'canary.json');
    fs.mkdirSync(path.join(snapshot, 'docker/workbench'), { recursive: true });
    fs.writeFileSync(canary, 'private-canary');
    if (kind === 'file') fs.symlinkSync(canary, path.join(snapshot, 'docker/workbench/opencode.json'));
    else {
      fs.rmdirSync(path.join(snapshot, 'docker/workbench'));
      fs.symlinkSync(root, path.join(snapshot, 'docker/workbench'));
    }
    const read = vi.spyOn(fs, 'readFileSync');
    const copy = vi.fn();
    try {
      expect(() => agentSourceFiles(snapshot, agentRegistry).forEach(copy)).toThrow(/escapes root/);
      expect(read).not.toHaveBeenCalled();
      expect(copy).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
    expect(fs.readFileSync(canary, 'utf8')).toBe('private-canary');
    fs.rmSync(root, { recursive: true, force: true });
  });
  it.each(['file', 'url', 'sha256'])('rejects bad archive %s before cache I/O or download', async field => {
    const specs = PINNED.artifacts.node;
    const saved = specs.x86_64;
    specs.x86_64 = { ...saved, [field]: ({ file: '../canary', url: 'http://bad.test/a', sha256: 'bad' })[field] };
    const mkdir = vi.spyOn(fsp, 'mkdir');
    const read = vi.spyOn(fs, 'readFileSync');
    const download = vi.fn();
    try {
      await expect(ensureArtifacts({ arch: 'x86_64', cacheDir: '/unused', download })).rejects.toThrow(/invalid task agent registry/);
      expect(download).not.toHaveBeenCalled();
      expect(mkdir).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    } finally { specs.x86_64 = saved; vi.restoreAllMocks(); }
  });
  it.each(['file', 'parent', 'dangling'])('rejects cache %s symlink escape before read, download or write', async kind => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cache-'));
    const cacheDir = path.join(root, 'cache');
    const canary = path.join(root, 'canary');
    fs.mkdirSync(path.join(cacheDir, 'x86_64'), { recursive: true });
    fs.writeFileSync(canary, 'private-canary');
    const file = PINNED.artifacts['agent-opencode'].x86_64.file;
    if (kind === 'parent') {
      fs.rmdirSync(path.join(cacheDir, 'x86_64'));
      fs.symlinkSync(root, path.join(cacheDir, 'x86_64'));
    } else fs.symlinkSync(kind === 'dangling' ? path.join(root, 'missing') : canary, path.join(cacheDir, 'x86_64', file));
    const read = vi.spyOn(fs, 'createReadStream');
    const write = vi.spyOn(fsp, 'writeFile');
    const rename = vi.spyOn(fsp, 'rename');
    const download = vi.fn();
    try {
      await expect(ensureArtifacts({ arch: 'x86_64', cacheDir, download })).rejects.toThrow(/escapes root|symlink escape/);
      expect(download).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
    expect(fs.readFileSync(canary, 'utf8')).toBe('private-canary');
    expect(fs.existsSync(path.join(root, 'missing'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('rechecks artifacts at the real host tar access site', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tar-'));
    const cache = path.join(root, 'cache');
    fs.mkdirSync(cache);
    fs.writeFileSync(path.join(root, 'canary'), 'private');
    fs.symlinkSync(path.join(root, 'canary'), path.join(cache, 'agent.tgz'));
    const plan = buildPlan({
      machineName: 'lifemodel-test-0123456789abcdef', snapshotPath: '/unused',
      artifacts: [{ key: 'agent-opencode', file: 'agent.tgz' }], artifactsHostDir: cache,
      bootstrapScriptDir: '/unused',
    });
    const invoker = createOrbInvoker({ orbctlPath: '/must-not-spawn' });
    try {
      await expect(invoker.runStep(plan.find(step => step.id === 'stage-artifacts'))).rejects.toThrow(/escapes root/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('registry readers fail closed at startup', () => {
  it.each(['core', 'launcher', 'shipped provisioner', 'fixture provisioner'])(
    'rejects a bad %s registry before any agent operation', reader => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-startup-'));
      const copy = (file: string) => {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.copyFileSync(file, path.join(root, file));
      };
      for (const file of [
        'src/ports/task-harness-names.ts', 'src/ports/task-agent-validation.mjs',
        'loader/src/task-harness-registry.ts', 'scripts/task-agent-provision.mjs',
        'scripts/task-agent-paths.mjs',
      ]) copy(file);
      fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
      const registry = structuredClone(agentRegistry);
      if (reader !== 'fixture provisioner') Object.values(registry)[0].provision.files[0].source = '../../../owner-secret';
      fs.writeFileSync(path.join(root, 'src/ports/task-harness-registry.json'), JSON.stringify(registry));
      if (reader === 'fixture provisioner') {
        const fixture = structuredClone(testAgentRegistry.scripted);
        fixture.provision.files[0].mode = '4777';
        fs.mkdirSync(path.join(root, 'tests/fixtures'), { recursive: true });
        fs.writeFileSync(path.join(root, 'tests/fixtures/task-agent-registry.json'), JSON.stringify({ scripted: fixture }));
      }
      const script = reader === 'core' ? 'src/ports/task-harness-names.ts' : reader === 'launcher' ?
        'loader/src/task-harness-registry.ts' : 'scripts/task-agent-provision.mjs';
      try {
        const result = spawnSync(process.execPath, [path.join(root, script)], { encoding: 'utf8', timeout: 10_000 });
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain('invalid task agent registry');
        expect(result.stderr).toContain(reader === 'fixture provisioner' ? 'file mode' : 'file source');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  );
});
