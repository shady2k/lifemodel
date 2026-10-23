# Task workbench image

Task: lifemodel-653.8.3. This is the stage-3 OpenCode workbench of
[ADR-014 D1/T02](../../adr/014-task-runtime.md). It is **not** the core image.
Prime Agent joins this same image in stage 4. No second task image is selected.

## Contents and pins

`docker/workbench/Dockerfile` builds Linux/amd64 from the same release commit
as the core, loader and web images. Unsupported architectures fail closed.

| Input | Pin / location |
| --- | --- |
| Node | `24.21.0-bookworm-slim`, manifest digest `sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20` (same version as the isolated test boundary) |
| Native tools/libraries | Debian bookworm archive `20261015T000000Z`; signed apt indexes freeze git, build-essential, Python 3, ripgrep, curl, CA certificates and their dependencies |
| OpenCode | `1.19.4`, official Linux x64 **baseline** archive; SHA-256 `1697ef40558d378bd2f72efa8fafe1bed1f0e664f09247b9357556b95dbc7cbc` |
| Development dependencies | Root `package-lock.json` from this commit, installed by `npm ci --legacy-peer-deps` at `/opt/lifemodel/node_modules`, with native install steps completed during build |
| Storage CLI | This commit's compiled `loader/src/storage-cli*.ts` at `/opt/lifemodel/loader/dist/`, wrapper `/usr/local/bin/lifemodel-storage` |
| Launcher | This commit's compiled `loader/src/task-launcher-main.ts`, wrapper `/usr/local/bin/lifemodel-task-launcher` (the image ENTRYPOINT) |

The OpenCode archive is the [official release asset](https://github.com/anomalyco/opencode/releases/tag/v1.19.4).
The checksum comes from its [asset metadata](https://api.github.com/repos/anomalyco/opencode/releases/tags/v1.19.4)
and is checked before extraction. The baseline binary avoids a build-host AVX2
selection. A direct archive avoids the official `opencode-ai` npm package's
postinstall platform probing and fallback npm install. No remote installer,
`npx` resolution or mutable version selector is used for the harness.
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
`HOME=/work/home`, `TMPDIR=/work/tmp` and all XDG paths below HOME. The Job must
mount its own writable work volume at `/work` and set UID/GID/fsGroup 1000.
No shared workspace, keys, auth files, owner `.npmrc`, repository `.git`, source
checkout or local data enters the build context. The Dockerfile-specific
`docker/workbench/Dockerfile.dockerignore` is an allowlist independent of the
loader context.

Startup does not install dependencies or contact an external bootstrap service.
`--self-check` creates only the private HOME/tmp directories, checks the baked
CLI/config/dev-dependency files, runs `node --version`, `opencode --version`,
`git --version` and `lifemodel-storage --help`, and exits 0. Any other invocation
exits 1 with **`launcher_not_implemented`**. It cannot start a harness before
653.8.7 implements the verified binding handshake. A successful version check
is not proof that an OpenCode model/tool session is implemented or accepted.

The launcher shares `loader/src/` because that already builds Node CLI modules
with a strict TypeScript config. Only the two storage modules and launcher
module ship, not the loader server, its dependencies, custody or seed bundle.

A self-change checkout can link its `node_modules` to the baked dependencies and
use their local binaries without npm network. The image does **not** ship Docker,
a Docker socket or permission to start another container. The repository's
isolated test entrypoint still requires its own approved execution boundary and
store endpoints; baked dependencies alone do not authorize running tests on the
host or make every repository gate runnable inside a task Job.

## Baked non-secret OpenCode configuration

`/etc/lifemodel/opencode.json` is selected by `OPENCODE_CONFIG`. It disables
updates and sharing and records the task endpoint placeholder
`https://model-gateway.lifemodel-system.svc:8446/v1`. No API key is configured.
`OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_DISABLE_MODELS_FETCH`,
`OPENCODE_DISABLE_PROJECT_CONFIG`, `OPENCODE_DISABLE_DEFAULT_PLUGINS`,
`OPENCODE_DISABLE_LSP_DOWNLOAD`, `OPENCODE_DISABLE_EXTERNAL_SKILLS`,
`OPENCODE_DISABLE_CLAUDE_CODE` and `OPENCODE_PURE` disable their respective
update/catalog/project/plugin/download paths. System ripgrep avoids its native
downloader. All are baked boolean `true` values.

653.8.7 must finish provider/model selection and the transport relay if needed,
add task identity only after the gateway's once-only start claim, reread rotating
tokens and validate the projected public CA. It must verify real shell/model,
steering and Stop behavior and any additional offline bootstrap needs. The
placeholder alone is not a functioning OpenAI-compatible provider or permission
to use the gateway. At this OpenCode pin, actual config loading can also install
`@opencode-ai/plugin` in writable config directories even with pure/default
plugins disabled. 653.8.7 must preprovision that exact config dependency or use
validated read-only config directories and verify a real run without bootstrap
network. The native version path does not load it. Disabling plugins is not a
universal network sandbox.

The existing storage CLI reads `LIFEMODEL_STORAGE_ENDPOINT`,
`LIFEMODEL_STORAGE_SPACE`, `LIFEMODEL_STORAGE_TOKEN_FILE` and
`LIFEMODEL_STORAGE_CA_FILE`. None is supplied as an image credential. Admission
currently forbids **all Job env overrides**, so 653.8.7 must map verified task
binding/mounted identity into the storage child process, not add arbitrary
Job env injection. Tokens/CA are read-only projected directories, never baked.

## CI and release

`ci-workbench-image` builds affected pull requests without a registry login,
write token or push. It also runs the self-check without networking, with a
read-only root and a private writable `/work`. Its selector fails safe when the
changed range is unknown. Like `ci-loader-image`, this is a conditional PR image
job; the existing branch-protection required checks are unchanged.

The release workflow builds and pushes the workbench, then
`scripts/release/set-workbench-digest.sh` substitutes its digest in
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

To update OpenCode, choose one exact official release, read its baseline Linux
asset SHA-256 from the tagged release metadata, update both Dockerfile constants
and this document, and inspect that release's config/bootstrap changes. Rebuild,
verify the checksum and repeat the no-network/read-only checks. Run the contract
test and full isolated check. Add another architecture only with its own pinned
archive/checksum and offline receipt. Never update a harness at task start.

Local Linux/amd64 measurement (2026-10-23, audited CPU-only rebuild): Docker
reports **2,208,704,446 bytes** (2.06 GiB, uncompressed), after a **296 s** build.
The Node base was cached; apt, OpenCode, both dependency installs and the
network-denied native setup were rerun. The install log contains 1,008 npm
fetches (941 unique URLs), all matching integrity-pinned resolved URLs in the
two lockfiles; no ONNX GitHub release download occurred. The separate OpenCode
GitHub archive download is intentional and checksum-verified. This is a
development workbench, not a slim production core image. The build cache is
retained; local image tags are removed after verification. Registry compression
and a cold CI build have different size/time costs.
