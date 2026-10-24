/** Build-time only. All agent pins, extraction and immutable files come from the registry. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const agentRegistry = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/ports/task-harness-registry.json'), 'utf8'));
const fixturePath = path.join(ROOT, 'tests/fixtures/task-agent-registry.json');
export const contractRegistry = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
export const testAgentRegistry = { ...agentRegistry, ...contractRegistry };
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function nativeAgentArch(arch) {
  return ({ amd64: 'x86_64', x64: 'x86_64', arm64: 'aarch64' })[arch] ?? arch;
}
export function agentArtifacts(registry = agentRegistry) {
  return Object.fromEntries(Object.entries(registry).filter(([, agent]) => agent.provision.archives)
    .map(([name, agent]) => [`agent-${name}`, agent.provision.archives]));
}
export function agentInstallScript(name, agent, archive, sourceRoot = '.', destinationRoot = '') {
  const target = file => quote(destinationRoot + file);
  const commands = [];
  if (agent.provision.archives) {
    if (!archive) throw new Error(`missing pinned agent archive: ${name}`);
    const temp = `/tmp/lifemodel-agent-${name}`;
    commands.push(`mkdir -p ${quote(temp)}`, `tar -xzf ${quote(archive)} -C ${quote(temp)} ${quote(agent.provision.archiveMember)}`,
      `install -D -m 0555 ${quote(temp + '/' + agent.provision.archiveMember)} ${target(agent.command)}`, `rm -rf ${quote(temp)}`);
  }
  for (const file of agent.provision.files ?? []) {
    commands.push(`install -D -m ${quote(file.mode ?? '0444')} ${quote(path.join(sourceRoot, file.source))} ${target(file.destination)}`);
  }
  for (const dir of agent.provision.directories ?? []) commands.push(`mkdir -p ${target(dir)}`, `chmod 0555 ${target(dir)}`);
  commands.push(`test "$(${target(agent.command)} ${agent.versionArgs.map(quote).join(' ')})" = ${quote(agent.versionOutput)}`);
  return commands.join('; ');
}
export function agentProvisionScript(arch, registry = agentRegistry, sourceRoot = '.', destinationRoot = '') {
  return Object.entries(registry).map(([name, agent]) => {
    const spec = agent.provision.archives?.[nativeAgentArch(arch)];
    if (agent.provision.archives && !spec) throw new Error(`no pinned agent archive: ${name}/${arch}`);
    const archive = `/tmp/lifemodel-${name}.tgz`;
    return [
      ...(spec ? [`curl --fail --location --retry 3 ${quote(spec.url)} -o ${quote(archive)}`,
        `printf '%s  %s\\n' ${quote(spec.sha256)} ${quote(archive)} | sha256sum -c -`] : []),
      agentInstallScript(name, agent, spec ? archive : undefined, sourceRoot, destinationRoot),
      ...(spec ? [`rm ${quote(archive)}`] : []),
    ].join('; ');
  }).join('; ');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Docker build copies only shipped registry and agent-owned build inputs.
  process.stdout.write(agentProvisionScript(process.arch, agentRegistry, ROOT));
}
