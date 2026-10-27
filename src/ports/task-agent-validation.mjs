/** Pure registry policy shared by build provisioning, core and launcher. No host I/O. */
const fail = field => { throw new Error(`invalid task agent registry: ${field}`); };
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const basename = value => text(value) && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== '..';
export function safeRelativePath(value) {
  return text(value) && !value.includes('\\') && value.split('/').every(basename);
}
const destination = value => text(value) && ['/usr/local/bin/', '/etc/lifemodel/'].some(prefix =>
  value.startsWith(prefix) && safeRelativePath(value.slice(prefix.length)));
export function validateArtifact(spec) {
  if (!object(spec) || !basename(spec.file)) fail('archive file');
  let url;
  try { url = new URL(spec.url); } catch { fail('archive URL'); }
  if (!text(spec.url) || url.protocol !== 'https:' || !url.hostname || url.username || url.password) fail('archive URL');
  if (typeof spec.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(spec.sha256)) fail('archive SHA-256');
  return spec;
}
export function validateAgentRegistry(registry, fixtureNames = []) {
  if (!object(registry)) fail('registry');
  for (const [name, agent] of Object.entries(registry)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || !object(agent)) fail('agent name');
    const fixture = fixtureNames.includes(name);
    for (const field of ['label', 'version', 'versionOutput']) if (!text(agent[field])) fail(field);
    if (agent.protocol !== 'acp') fail('protocol');
    if (!text(agent.command) || !agent.command.startsWith('/usr/local/bin/') || !basename(agent.command.slice('/usr/local/bin/'.length))) fail('command destination');
    if (!destination(agent.configFile) || !agent.configFile.startsWith('/etc/lifemodel/')) fail('config destination');
    for (const field of ['args', 'versionArgs']) if (!Array.isArray(agent[field]) || !agent[field].every(value => typeof value === 'string' && !value.includes('\0'))) fail(field);
    if (!(typeof agent.adapterModule === 'string' && (/^\.\/task-[a-z0-9-]+\.js$/.test(agent.adapterModule) ||
      (fixture && /^\.\.\/\.\.\/tests\/fixtures\/task-[a-z0-9-]+\.mjs$/.test(agent.adapterModule))))) fail('adapter module');
    if (agent.contractModule !== undefined && (typeof agent.contractModule !== 'string' || !/^\.\.\/\.\.\/tests\/fixtures\/task-[a-z0-9-]+\.ts$/.test(agent.contractModule))) fail('contract module');
    if (agent.adapterConfig !== undefined) {
      if (!object(agent.adapterConfig) || !destination(agent.adapterConfig.settingsFile) ||
          !/^\/opt\/lifemodel\/agents\/[a-z0-9-]+-python\/bin\/python$/.test(agent.adapterConfig.kernelPython)) fail('adapter config');
    }
    const provision = agent.provision;
    if (!object(provision)) fail('provision');
    if (provision.archiveLayout !== undefined && provision.archiveLayout !== 'distribution') fail('archive layout');
    if (provision.archiveLayout && !provision.archives) fail('archive options');
    if (provision.archives !== undefined) {
      if (!object(provision.archives) || Object.keys(provision.archives).length === 0) fail('archives');
      for (const [arch, spec] of Object.entries(provision.archives)) {
        if (!['x86_64', 'aarch64'].includes(arch)) fail('architecture');
        validateArtifact(spec);
      }
      if (!safeRelativePath(provision.archiveMember)) fail('archive member');
    }
    if (provision.pythonRequirements !== undefined && (!provision.archiveLayout || !safeRelativePath(provision.pythonRequirements) || !/^docker\/workbench\/[^/]+\.txt$/.test(provision.pythonRequirements) || !safeRelativePath(provision.pythonRuntime))) fail('python requirements');
    if (provision.pythonRuntime !== undefined && !provision.pythonRequirements) fail('python runtime');
    if (provision.files !== undefined && !Array.isArray(provision.files)) fail('files');
    for (const file of provision.files ?? []) {
      if (!object(file) || !safeRelativePath(file.source) || !(fixture ?
        /^tests\/fixtures\/[^/]+$/.test(file.source) : /^docker\/workbench\/[^/]+\.json$/.test(file.source))) fail('file source');
      if (!destination(file.destination)) fail('file destination');
      if (file.mode !== undefined && !['0444', '0555'].includes(file.mode)) fail('file mode');
    }
    if (agent.adapterConfig && (!provision.files?.some(file => file.destination === agent.adapterConfig.settingsFile) ||
        agent.adapterConfig.kernelPython !== `/opt/lifemodel/agents/${name}-python/bin/python` || !provision.pythonRequirements)) fail('adapter config provisioning');
    if (provision.directories !== undefined && !Array.isArray(provision.directories)) fail('directories');
    for (const dir of provision.directories ?? []) if (!destination(dir) || !dir.startsWith('/etc/lifemodel/')) fail('directory destination');
  }
  return registry;
}
