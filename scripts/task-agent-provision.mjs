/** Build-time only. All agent pins, extraction and immutable files come from the registry. */
import fs from 'node:fs';
import { validateAgentRegistry } from '../src/ports/task-agent-validation.mjs';
import { realPathWithin } from './task-agent-paths.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const agentRegistry = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/ports/task-harness-registry.json'), 'utf8'));
const fixturePath = path.join(ROOT, 'tests/fixtures/task-agent-registry.json');
export const contractRegistry = fs.existsSync(fixturePath) ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')) : {};
if (Object.keys(contractRegistry).some(name => Object.hasOwn(agentRegistry, name))) throw new Error('duplicate fixture agent');
validateAgentRegistry(agentRegistry);
validateAgentRegistry(contractRegistry, Object.keys(contractRegistry));
export const testAgentRegistry = { ...agentRegistry, ...contractRegistry };
export function validateProvisionRegistry(registry) {
  return validateAgentRegistry(registry, Object.keys(contractRegistry));
}
export function agentSourceFiles(snapshot, registry = testAgentRegistry) {
  validateProvisionRegistry(registry);
  // Resolve the whole batch before a caller can read even the first source.
  return Object.values(registry).flatMap(agent => [
    ...(agent.provision.files ?? []),
    ...(agent.provision.pythonRequirements ? [{ source: agent.provision.pythonRequirements }] : []),
  ])
    .map(file => ({ ...file, hostPath: realPathWithin(snapshot, file.source) }));
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function nativeAgentArch(arch) {
  return ({ amd64: 'x86_64', x64: 'x86_64', arm64: 'aarch64' })[arch] ?? arch;
}
export function agentArtifacts(registry = agentRegistry) {
  validateProvisionRegistry(registry);
  return Object.fromEntries(Object.entries(registry).filter(([, agent]) => agent.provision.archives)
    .map(([name, agent]) => [`agent-${name}`, agent.provision.archives]));
}
export function agentInstallScript(name, agent, archive, sourceRoot = '.', destinationRoot = '') {
  validateProvisionRegistry({ [name]: agent });
  // A venv embeds its creation path and cannot be relocated after provisioning.
  if (destinationRoot !== '') throw new Error('destinationRoot is not supported');
  const target = file => quote(file);
  const commands = [];
  if (agent.provision.archives) {
    if (!archive) throw new Error(`missing pinned agent archive: ${name}`);
    const temp = `/tmp/lifemodel-agent-${name}`;
    if (agent.provision.archiveLayout === 'distribution') {
      const dir = `/opt/lifemodel/agents/${name}`;
      // Reject links and special files before extracting any member. Extraction uses
      // a private fresh directory, not an existing tree that could contain links.
      const extract = `import os, sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    members = archive.getmembers()
    seen = set()
    for member in members:
        name = member.name.rstrip('/')
        parts = name.split('/')
        if not name or name.startswith('/') or any(part in ('', '.', '..') for part in parts) or name in seen or not (member.isfile() or member.isdir()):
            raise ValueError('unsafe archive member: ' + member.name)
        seen.add(name)
        member.uid, member.gid = os.getuid(), os.getgid()
        member.uname = member.gname = ''
        member.mode &= 0o755
    archive.extractall(sys.argv[2], members=members)`;
      commands.push(`stage=$(mktemp -d)`, `trap 'rm -rf "$stage"' EXIT`,
        `python3 -c ${quote(extract)} ${quote(archive)} "$stage"`,
        `test -f "$stage/${agent.provision.archiveMember}"`,
        `mkdir -p ${quote(path.dirname(dir))}`, `test ! -e ${target(dir)}`, `test ! -L ${target(dir)}`,
        `mv "$stage" ${target(dir)}`, `trap - EXIT`,
        `chmod -R a+rX,go-w ${target(dir)}`, `ln -s ${quote(dir + '/' + agent.provision.archiveMember)} ${target(agent.command)}`);
    } else {
      commands.push(`mkdir -p ${quote(temp)}`, `tar -xzf ${quote(archive)} -C ${quote(temp)} ${quote(agent.provision.archiveMember)}`,
        `install -D -m 0555 ${quote(temp + '/' + agent.provision.archiveMember)} ${target(agent.command)}`, `rm -rf ${quote(temp)}`);
    }
  }
  if (agent.provision.pythonRequirements) {
    const python = `/opt/lifemodel/agents/${name}-python`;
    const runtime = `/opt/lifemodel/agents/${name}/${agent.provision.pythonRuntime}`;
    commands.push(`python3 -m venv ${target(python)}`,
      `${target(python + '/bin/python')} -m pip install --no-cache-dir --only-binary=:all: --require-hashes -r ${quote(path.join(sourceRoot, agent.provision.pythonRequirements))}`,
      `site=$(${target(python + '/bin/python')} -c 'import site; print(site.getsitepackages()[0])')`,
      `printf '%s\n' ${quote(runtime)} > "$site/lifemodel-runtime.pth"`,
      `chmod -R a+rX,go-w ${target(python)}`);
  }
  for (const file of agent.provision.files ?? []) {
    commands.push(`install -D -m ${quote(file.mode ?? '0444')} ${quote(path.join(sourceRoot, file.source))} ${target(file.destination)}`);
  }
  for (const dir of agent.provision.directories ?? []) commands.push(`mkdir -p ${target(dir)}`, `chmod 0555 ${target(dir)}`);
  commands.push(`test "$(${target(agent.command)} ${agent.versionArgs.map(quote).join(' ')})" = ${quote(agent.versionOutput)}`);
  return commands.join('; ');
}
export function agentProvisionScript(arch, registry = agentRegistry, sourceRoot = '.', destinationRoot = '') {
  if (destinationRoot !== '') throw new Error('destinationRoot is not supported');
  validateProvisionRegistry(registry);
  return Object.entries(registry).map(([name, agent]) => {
    const spec = agent.provision.archives?.[nativeAgentArch(arch)];
    if (agent.provision.archives && !spec) {
      throw new Error(`no pinned agent archive: ${name}/${arch}`);
    }
    const archive = `/tmp/lifemodel-${name}.tgz`;
    return [
      ...(spec ? [`curl --proto '=https' --proto-redir '=https' --fail --location --retry 3 ${quote(spec.url)} -o ${quote(archive)}`,
        `printf '%s  %s\\n' ${quote(spec.sha256)} ${quote(archive)} | sha256sum -c -`] : []),
      agentInstallScript(name, agent, spec ? archive : undefined, sourceRoot, destinationRoot),
      ...(spec ? [`rm ${quote(archive)}`] : []),
    ].join('; ');
  }).filter(Boolean).join('; ');
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Docker build copies only shipped registry and agent-owned build inputs.
  agentSourceFiles(ROOT, agentRegistry);
  process.stdout.write(agentProvisionScript(process.arch, agentRegistry, ROOT));
}
