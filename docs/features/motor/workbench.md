# Task workbench image

Task: lifemodel-653.8.3. `docker/workbench/Dockerfile` builds the OpenCode workbench of
[ADR-014 D1/T02](../../adr/014-task-runtime.md). It is **not** the core image.
`src/ports/task-harness-registry.json` configures OpenCode and prime-agent 0.10.1 in this same image. OpenCode remains the default. No second task image is selected.

## Steering bridge

The registry also provisions `docker/workbench/steering-plugin/` at
`/etc/lifemodel/steering-plugin`. The dedicated Docker context allowlist admits
its two source files. It has no package dependency and needs no startup install.
OpenCode loads it from the rendered private configuration, then the launcher
admits input over `/work/.launcher/steer.sock`. Prime uses the existing ACP daemon's
private `/work/.launcher/daemon.sock`, with exactly one root bound before the brief.
The journal and channels are launcher-owned, outside TMPDIR, not a trust
boundary; receipts are task claims in the single untrusted Pod zone.
Neither channel adds Pod ingress or a second agent engine. See
[task harness admission](task-harness.md#native-admission-and-launcher-owned-journal)
for journal, receipts and uncertainty. The end-of-turn barrier is separate
lifemodel-653.9.6 work; this bridge alone does not settle the final-answer race.

## Contents and pins

`docker/workbench/Dockerfile` consumes architecture pins and extraction/config
inputs from `src/ports/task-harness-registry.json` through
`scripts/task-agent-provision.mjs`. The same input provisions both isolated test
paths. Both agents require verified Linux amd64 and arm64 pins; a missing pin fails the build.

| Input | Pin / location |
| --- | --- |
| Node | `24.21.0-bookworm-slim`, manifest digest `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` (same version as the isolated test boundary) |
| Native tools/libraries | Debian bookworm archive `20261015T000000Z`; signed apt indexes freeze git, build-essential, Python 3, ripgrep, curl, CA certificates and their dependencies |
| OpenCode | `2.1.4`, native npm Linux x64 archive; SHA-256 `ce05abe2dce1041391c8ec8cdb8da066f640fd471e72ac846dcb089c441e11e1` |
| Prime Agent | `0.10.1` Linux x64 SHA-256 `21ec219183f4134dd23dce9572102e69456066fe374846525561c776d4d1945c`; arm64 SHA-256 `5af68c10a088538fd4990fd18778d8c7fe28c0491083dc069c5177f733770e91`. The complete adjacent distribution and Python runtime are installed at build time. Python wheels are version- and hash-pinned in `docker/workbench/prime-python-requirements.txt`; its explicit index is PyPI. The universal resolution preserves marker-gated dependencies for Python 3.11 and 3.12 on Linux amd64 and arm64. |
| Development dependencies | Root `package-lock.json` from this commit, installed by `npm ci --legacy-peer-deps` at `/opt/lifemodel/node_modules`, with native install steps completed during build |
| Storage CLI | This commit's compiled `loader/src/storage-cli*.ts` at `/opt/lifemodel/loader/dist/`, wrapper `/usr/local/bin/lifemodel-storage` |
| Launcher | This commit's compiled `loader/src/task-launcher-main.ts`, wrapper `/usr/local/bin/lifemodel-task-launcher` (the image ENTRYPOINT) |

The OpenCode archive is the exact `@opencode/cli-linux-x64@2.1.4` npm
platform package. Registry integrity and tagged source references are recorded
in [OpenCode v2 facts](task-harness.md#opencode-v2-facts). Build verifies SHA-256
before extracting the native executable. No postinstall, remote installer,
`npx` resolution or mutable version selector runs at task startup.
These pins reproduce the installed inputs; they do not assert byte-for-byte
reproducible upstream binaries or OCI timestamps.

Apt bootstraps CA certificates over HTTP, with the snapshot's exact `InRelease`
pinned to SHA-256 `77737fa4b34f2693e982cc9ee35736816c35a7778fc2d326cc1bbf5b301fe1aa`.
The build verifies that hash before apt update, then compares the metadata apt
actually used with those verified bytes before installing packages. Debian's
signature checks and index/package hashes remain enabled. This prevents replay
of a different legitimately signed archive during bootstrap. This bookworm
metadata has no `Valid-Until`, so no expiry override is needed. Apt update fails
on any fetch error. Harness downloads use HTTPS and the recorded checksum.

### npm lifecycle policy (CPU only)

Both root and loader `npm ci` run with `--ignore-scripts`. Package tarballs are
verified against the committed lockfile integrity; no lifecycle runs while the
fetch step has network access. A separate `RUN --network=none` replays only
`esbuild`, `onnxruntime-node`, `protobufjs` and `sharp` with foreground logs.
`ONNXRUNTIME_NODE_INSTALL_CUDA=skip` makes the exact ONNX installer exit before
URL selection or download; its CPU binding/runtime already ship in the npm
package. No GPU asset enters this image. Any unexpected fallback requiring
network fails closed, rather than silently adding unchecked native bytes.

Audit of exact integrity-verified packages in this lock (and their install
entrypoints, not development/publishing scripts):

| Package / lifecycle | Fetch behavior and build policy |
| --- | --- |
| `esbuild@0.27.2`, `postinstall: node install.js` | Uses the lockfile's optional platform binary. If missing, tries nested npm then a direct registry tarball download without its own integrity check. Replay runs without network; missing platform binary cannot fetch. |
| `onnxruntime-node@1.21.0`, `postinstall: node ./script/install` | Default Linux/x64 downloads an unchecked CUDA GitHub release and can overwrite the CPU library. `ONNXRUNTIME_NODE_INSTALL_CUDA=skip` is checked first and exits before download. Replay is also network-denied. |
| `protobufjs@7.5.4`, `postinstall: node scripts/postinstall` | Reads local JSON and prints a version-scheme warning. No fetch. Replay is network-denied. |
| `sharp@0.34.5`, `install: node install/check.js || npm run build` | Uses optional `@img` prebuilt packages from the lockfile. Global libvips or source-build configuration can trigger node-gyp, which could fetch Node headers. Replay is network-denied, so that fallback cannot download. |
| `fsevents@2.3.3` | Lock has an install marker, but the published tarball has no install lifecycle or `binding.gyp`; its native binary is bundled. Darwin-only optional package, excluded on Linux; not replayed. |
| Root `prepare: husky` (`husky@9.1.7`) | Local git/hook writes only, no fetch. Skipped; no repository hooks belong in the image. |
| Loader dependencies | No install lifecycle markers or root install hooks. All scripts are skipped during `npm ci`; compilation is explicit. |

The contract test fixes this audited package/version inventory. An added or
upgraded installer requires a fresh source audit and an explicit offline policy;
never remove `--ignore-scripts` or broadly enable install scripts. Network-free
replay and retained optional packages also cover native fallback risks, not just
the current ONNX download.

## Offline startup and private writes

The image runs as UID/GID **1000**, with read-only root support, `WORKDIR /work`,
`HOME=/work/home`, `TMPDIR=/work/tmp` and mutable XDG paths below HOME.
The global XDG config path is the baked read-only `/etc/lifemodel/xdg`. The Job must
mount its own writable work volume at `/work` and set UID/GID/fsGroup 1000.
No shared workspace, keys, auth files, owner `.npmrc`, repository `.git`, source
checkout or local data enters the build context. The Dockerfile-specific
`docker/workbench/Dockerfile.dockerignore` is an allowlist independent of the
loader context.

Startup does not install dependencies or contact an external bootstrap service.
`--self-check` creates only the private HOME/tmp directories, checks the baked
CLI/config/dev-dependency files, runs generic tool checks and each registered
agent's version/config self-check, and exits 0. With no arguments the launcher runs the [task harness](task-harness.md):
authenticated identity discovery, one gateway start claim, one won-claim briefing
read and one ACP session. Unknown arguments exit nonzero. A successful
version check alone does not prove a model/tool session.

The launcher shares `loader/src/` because that already builds Node CLI modules
with a strict TypeScript config. Only the storage and task runtime modules ship, not the loader server, its dependencies, custody or seed bundle.

A self-change checkout can link its `node_modules` to the baked dependencies and
use their local binaries without npm network. The image does **not** ship Docker,
a Docker socket or permission to start another container. The repository's
isolated test entrypoint still requires its own approved execution boundary and
store endpoints; baked dependencies alone do not authorize running tests on the
host or make every repository gate runnable inside a task Job.

## Baked non-secret OpenCode configuration

`/etc/lifemodel/opencode.json` is the first agent's registry-selected config.
v2 uses `update: "disable"`, no sharing, no LSP/formatter, no warming and no
external plugins. The agent module supplies the native OpenAI-compatible
provider with its loopback relay URL at launch. Only the relay rereads the
projected model token and validates the gateway CA; a non-secret placeholder
API key in agent configuration is not authority.

The config module owns all v2 environment flags. Project config, Claude skills,
models catalog fetch and update checks are disabled. Config roots remain
read-only. Private data/cache/state/log paths stay under `/work`. The v1 plugin
bootstrap workaround is removed, not carried as compatibility code. Real ACP
runs must prove no startup egress attempt; a version check alone is insufficient.
See the task harness document for the exact pin and source evidence.

The existing storage CLI reads `LIFEMODEL_STORAGE_ENDPOINT`,
`LIFEMODEL_STORAGE_SPACE`, `LIFEMODEL_STORAGE_TOKEN_FILE` and
`LIFEMODEL_STORAGE_CA_FILE`. None is supplied as an image credential. Admission
permits only the ten literal endpoint/space/identity-file/CA-file names in the
[task launch contract](task-launch.md). Arbitrary Job env, valueFrom and envFrom
remain forbidden. The six channel/model names are consumed by the launcher handshake,
briefing/channel client and model relay. Tokens/CA are read-only projected directories, never baked.

## Stage 4: prime-agent and local steering plugin

The registry appends `prime-agent` after OpenCode, preserving OpenCode as the
first-key default, with ACP command `--mode acp --offline
--no-session --provider task --model task`, exact version/output, adapter module,
contract fixture and architecture-specific verified archive pins. The upstream
[v0.10.1 SHA256SUMS](https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.10.1/SHA256SUMS)
lists both pins above. The arm64 archive was downloaded and its SHA-256 checked
against that file; its distribution contains `prime-agent` and
`prime-agent-runtime/src`. The archive check does not establish arm64 execution
acceptance; that remains to be tested on arm64. A missing pin fails provisioning. Provisioning includes
the adjacent bundled distribution, local runtime and baked Python
packages, not just the executable. Non-secret models/settings templates and
offline controls are baked in. The adapter renders the per-task relay URL into
private configuration and sets a private daemon socket. A network-disabled
startup trace of the reviewed amd64 build showed no IP connection attempts through ACP session creation ([trace and method](../../research/task-harness-acp/evidence/prime-workbench-startup/README.md)). The setting snapshots the selected
registry name into the accepted task; no caller or Job environment changes.

Bake the local OpenCode steering plugin; it is the sole exception to the no
external plugins rule, not an online dependency. ACP supplies launcher MCP
tools over a stdio subprocess at session creation. The stdio server is a thin
launcher-shipped shim relaying over an inherited pipe or launcher-private local
socket; it holds no channel credentials. Frames, IDs and limits are the
launcher’s and core’s. MCP and Prime offline MCP
support are unverified until tested. The two adapters and scripted fixture share the
contract suite. Prime's ACP permission gap and completed Python exception are
known probe limitations accepted by the owner; the barrier's daemon idle/result
signal remains unverified until implementation tests. See the
[ADR amendment](../../adr/014-task-runtime.md#amendment--2026-10-27-live-steering-behind-the-harness-port).

## CI and release

`ci-workbench-image` builds affected pull requests without a registry login,
write token or push. It also runs the self-check without networking, with a
read-only root and a private writable `/work`. Its selector fails safe when the
changed range is unknown. Like `ci-loader-image`, this is a conditional PR image
job; the existing branch-protection required checks are unchanged.

`ci-workbench-image-publish` (lifemodel-653.8.15) publishes the image on a push
to main, and only when the selector says the change reaches the workbench's
inputs; a missing or failed classification counts as owed, never as not owed,
and a pull request never reaches this job. It builds
`docker/workbench/Dockerfile`, runs the same offline, non-root, read-only-root
`--self-check`, and only then pushes
`ghcr.io/shady2k/lifemodel-workbench:main` and
`ghcr.io/shady2k/lifemodel-workbench:<commit sha>`, showing the pushed digest in
its log, as `ci-core-image-publish` and `ci-web-image-publish` do. It asks for
`packages: write` and nothing else. Those moving tags are not a release: nothing
pins them and no platform artifact names them.

The release workflow still builds and pushes the workbench under its release
tag, then `scripts/release/set-workbench-digest.sh` substitutes its digest in
`deploy/platform/applications/lifemodel/kustomization.yaml`. The overlay adds
`LIFEMODEL_TASK_WORKBENCH_IMAGE` to the **core** container. 653.8.5 must read and
validate that immutable launch input. The zero digest is a source placeholder,
never a deployable release. It is pinned **before** the loader seed bundle is
prepared, so the seed and signed platform artifact carry the same reference.

Only the platform artifact is signed by the existing keyless cosign flow. It
transitively pins the workbench; there is no separate signing key in a task.
The admission policy accepts that repository only by SHA-256 digest. It does
not duplicate a release-specific digest, avoiding two pin authorities.

## Build, verify and update

From a clean checkout, no prepared seed context is needed:

```sh
lifemodel-heavy docker build --file docker/workbench/Dockerfile --tag lifemodel-workbench:local .
docker run --rm --network none lifemodel-workbench:local --self-check
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges --tmpfs /work:uid=1000,gid=1000,mode=700 \
  lifemodel-workbench:local --self-check
```

To update OpenCode, choose the latest stable **v2** npm version, verify its
registry integrity, record the archive checksum and exact source commit, and
inspect its ACP/config/startup changes. Update the registry, image pin, test
provisioning and docs together. Rebuild and repeat offline self-check, real ACP
contract and network-attempt tracing. Never update a harness at task start.

The former v1 image measurements are superseded; v2 measurements and final
acceptance receipts are recorded in the worker report, not inferred here.

## Local registry delivery

The release publishes the workbench at the default source
`ghcr.io/shady2k/lifemodel-workbench`; CI also publishes the moving `main` and
commit tags there, which the import never reads. The loader settings can select
another HTTPS registry and OCI repository, with an optional Bao-held pull
credential. The digest is still the release pin (`LIFEMODEL_WORKBENCH_DIGEST`),
not a setting. An independent retriable loader task copies the exact OCI bytes
into zot; import does not hold application-source creation or first start.
Zot's `http.compat: ["docker2s2"]` also accepts Docker schema 2 images and
manifest lists from these configurable sources, without rewriting their bytes
or digest. Manifest lists need no additional compatibility option.
Jobs name only
`zot.lifemodel-system.svc:5001/lifemodel/workbench@sha256:<digest>`.
The digest is unchanged; no tag resolution or external-registry fallback happens
at Job start. Core validation and both CEL guards reject all other repositories.
Core anonymously HEADs the pinned zot manifest with a short deadline before task
acceptance. A missing/unreachable image refuses with `workbench_unavailable`,
creating neither a Job nor a task registry row. The same request proceeds after
import succeeds. Loader settings show `pending`, `importing`, `ready` or `failed`,
a safe reason and last attempt time. Destination upload 4xx responses other than
401/403 show `rejected`; the loader logs the HTTP status and request media type
without credentials or token-bearing URLs. Access failures remain `unauthorized`
and unreachable registries/server failures remain `unavailable`.
Saves trigger retry without restart; kills
resume from verified objects rather than a process-memory completion flag.

The node's installer-written k3s mirror routes that authority to
`http://10.43.0.51:5001`. Pull is anonymous, while the loader reads the sole
push password from OpenBao at use. Plain HTTP is the owner's interim choice;
TLS is lifemodel-pwe.2. See [ADR-010's amendment](../../adr/010-container-generations.md#amendment-zot-workbench-delivery-2026-10-24)
for trust, phase order and the cold-node acceptance boundary.
