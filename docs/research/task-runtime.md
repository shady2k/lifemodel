# Research: the harness inside a task and its S3 artifact store (lifemodel-653.4)

Date: 2026-10-20. Scope: the replaceable harness inside one Kubernetes Job,
and the in-cluster S3-compatible store for its durable output. This is research,
not an implementation or a deployment decision. Primary sources, installed CLI
inspection and bounded local probes supply the evidence. Unknowns are recorded
rather than treated as support.

## 1. Decision context and method

The task and all owner comments on lifemodel-653 were read with `br show` and
`br comments list` (read-only). The current feature is lifemodel-653, motor-1,
not the web-interface feature named in the inherited worker rules. The latest
owner decisions require separate Kubernetes Jobs, a replaceable harness, one
CI-built signed/pinned workbench image, no model or storage key inside a task,
and retained logs, results and marked artifacts in S3. Unmarked files and the
working volume disappear. MinIO is excluded by the owner; its archive date is
not needed to make that exclusion. Research does not amend ADR-010 or ADR-011.

The comparison follows the question/criteria/evidence/recommendation shape of
[jobs-engine.md](jobs-engine.md). Source links below distinguish documentation
from observations and design inferences. A successful local single-node probe
will not establish production durability, peak memory, proxy compatibility or
policy isolation for an untested release.

## 2. Harness inside a task

### 2.1 Criteria and shortlist

The first choice is **OpenCode**, provisionally, because it passes the strict
keyless endpoint and proxy checks without patching an agent. This is not a
claim that it is the best coding model: the local model was a scripted stub.

Besides the required prime-agent and DeepSeek candidates, include OpenCode,
Codex CLI and Pi. They cover three useful integration shapes: a provider-neutral
headless CLI with JSON events, a vendor-maintained compiled coding CLI, and the
small SDK/RPC harness from which prime-agent forked. All have current first-party
repositories and releases, rather than an abandoned demo. The release links and
per-candidate evidence below substantiate that shortlist; no popularity ranking
or coding benchmark was used.

### 2.2 Comparison at a glance

“Env-only” means configuration may be supplied as environment data but no
provider configuration file is required. “No key” means no real **or dummy**
API key is required and no Authorization header is sent. Short-lived storage
capabilities are a separate question in part 3.

| Candidate / evidence version | One briefing, tools, progress and result | Arbitrary keyless OpenAI endpoint, no config file | Proxy, resume and stop | Licence / maturity / footprint |
|---|---|---|---|---|
| **prime-agent 0.9.8 installed** | `--print`, JSONL/RPC; Python REPL provides shell/files, skills and subagents | **Not stock CLI.** Documented custom providers use `models.json`; simple OpenAI stream requires a key. An extension/SDK adapter is possible, not demonstrated | Resume sessions, RPC abort and stop command. Installed proxy behaviour not established by this run | MIT; independently developed Pi fork. Installed release files **172,169,686 bytes**, not a workbench image. Latest upstream is now **0.10.0**, a different implementation; do not extrapolate installed tests |
| **DeepSeek Harness (`dsh`)** | Official developer-preview harness; headless profile takes stdin, emits JSON events and a final result; shell/files | **Not stock default.** Default DeepSeek Messages transport requires `x-api-key`; alternate OpenAI-compatible providers require provider configuration | Documents HTTPS_PROXY and custom CA; named sessions and headless cancellation/lifecycle need adapter mapping | MIT; preview, not a settled production contract. No OCI image measured |
| **OpenCode 1.19.0 probed / 1.19.3 sources** | `run --format json`; shell/file tools; streamed tool/text/step events | **Yes in local probe.** `OPENCODE_CONFIG_CONTENT`, custom `@ai-sdk/openai-compatible`, `baseURL`, omit `apiKey` | HTTPS proxy + custom CA passed local probe. `--session` / `--continue`; server abort or terminate Job | MIT; active stable releases. Published 1.19.3 Linux x64 archive **60,716,380 bytes**; installed 1.19.0 payload **254,277,088 bytes**, before workbench tools |
| **Codex CLI 0.163.0 sources** | `codex exec`, JSONL events and last-message output; shell/patch tools | Custom no-key provider possible via inline `-c` overrides, but **Responses API only**, not an arbitrary Chat Completions gateway | Standard proxy/client configuration; `exec resume`; terminate process/Job. Not locally exercised here | Apache-2.0; official OpenAI project. Linux x64 musl archive **112,589,966 bytes**; not final image size |
| **Pi 1.3.0 sources** | Print / JSON / RPC and SDK; shell/read/edit/write | Custom providers documented through `models.json`, even local models require a dummy key; **fails strict gate** | Standard proxy support; saved sessions, RPC abort | MIT; upstream lineage, independently usable. Linux x64 archive **42,617,111 bytes**, not final image size |

### 2.3 Primary evidence and important distinctions

**Prime Agent.** The installed CLI reports `0.9.8`. Its bundled README,
`docs/models.md`, `docs/rpc.md`, `docs/sdk.md`, `docs/usage.md`, package manifest
and MIT licence were read locally. The public
[0.9.8 tag](https://github.com/PrimeIntellect-ai/prime-agent/tree/v0.9.8)
resolves to `7d442aafa985f9342134fac16c2ef41f03fb45c1`.
The [custom-model guide](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.8/packages/coding-agent/docs/models.md)
says the API key is required even when Ollama ignores it; the
[OpenAI completion source](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.8/packages/ai/src/providers/openai-completions.ts)
throws `No API key for provider` in the simple stream path. The
[RPC protocol](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.8/packages/coding-agent/docs/rpc.md)
has LF-delimited commands/events, prompt acceptance distinct from completion,
and abort. The [SDK](https://github.com/PrimeIntellect-ai/prime-agent/blob/v0.9.8/packages/coding-agent/docs/sdk.md)
offers in-memory session/model objects and custom tools; that is an adapter
option, not proof the CLI meets env-only/keyless requirements. The isolated
CLI probe failed earlier with `supervisor_generation_stale` (exit 1), so it
**did not test authentication or proxying**. No existing daemon was stopped or
reconfigured to work around it.

The [latest release API](https://api.github.com/repos/PrimeIntellect-ai/prime-agent/releases/latest)
reports 0.10.0 and a Linux x64 archive of 21,556,959 bytes. Public main at
`58f9e8bb0ef54956e2e796ef96723f20b43fc55d` uses Rust crates, unlike the
installed 0.9.8 TypeScript distribution. Its
[OpenAI completion source](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-ai/src/providers/openai_completions/mod.rs)
still returns a no-key error in the inspected path; its
[custom-CA change note](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/.changes/fix-custom-ca-trust.md)
claims OS roots and `NODE_EXTRA_CA_CERTS` support. This is source evidence,
not a probe of the latest release. A release pin must precede any acceptance
claim, including its daemon/process and Python runtime footprint.

**DeepSeek, OpenCode, Codex and Pi.** Release-pinned details are being integrated
from the independent primary-source review below. The table's conclusions are
conditional on those exact provider paths, not a claim that supporting the
DeepSeek *model* makes a project the DeepSeek *harness*.

### 2.4 Bounded local harness probes

- `timeout 15s prime-agent --help` and `timeout 10s prime-agent --version`:
  exits 0. Isolated `env -i` invocation with empty local HOME/config, no key,
  `OPENAI_BASE_URL` to a loopback unused port, no tools/extensions/skills,
  no context files/session, offline print: exit 1,
  `supervisor_generation_stale`. Inconclusive for endpoint/auth/proxy.
- `timeout 10s opencode --version`: **1.19.0**. `codex --version`:
  **0.162.1**; `pi --version`: **1.2.0**. The latter two were not model-probed.
- `timeout 30s env -i ... opencode run --pure --dir <empty-local-workdir>
  --format json --model probe/probe <briefing>`: exit 0 against a local scripted
  HTTP `/v1/chat/completions` endpoint. HOME/XDG paths were empty and local;
  inline JSON set a custom provider, `baseURL`, a model and allowed tools,
  **no apiKey**. Startup model fetch/default plugins/updates were disabled.
  The server asked for `bash` with `printf R6534_TOOL_OK`; the CLI executed it,
  returned its tool result and emitted final text `R6534_MOCK_OK` with
  `step_finish.reason=stop`. Three requests (including a title-side request)
  had **no Authorization header**. No paid endpoint was contacted.
- Repeat under `timeout 25s` against `https://model.probe.invalid/v1`, with
  HTTP_PROXY/HTTPS_PROXY to a local CONNECT proxy and NODE_EXTRA_CA_CERTS to
  a one-day self-signed test CA: exit 0; three CONNECT requests reached the
  proxy, the tool/result/final cycle passed, Authorization absent. The proxy
  mapped that deliberately non-resolving hostname to the local TLS stub.
  This proves this configured proxy path, not every tool's network library,
  production MITM policy or approved-domain enforcement. Both mock servers
  were closed and the TLS private key removed.

The first successful mock used a literal endpoint inside the inline environment
JSON. The documented config substitution `{env:OPENAI_BASE_URL}` can instead
supply its address; that substitution was source-reviewed, not separately
probed. All configuration comes from environment data; runtime session/cache
files **are** written and belong on the task's ephemeral volume. Disable
sharing, updates, default plugins, model refresh and LSP downloads; bake needed
binaries into the workbench. Never mount this machine's user config or memory.
Sources: [configuration](https://opencode.ai/docs/config/),
[CLI environment flags](https://opencode.ai/docs/cli/),
[network and CA settings](https://opencode.ai/docs/network/).

### 2.5 Recommendation, main risk, and evidence that would change it

**Recommend OpenCode as the first harness adapter**, pinned and baked into the
one workbench image. It is the only candidate in this run demonstrated to use
an arbitrary Chat Completions endpoint without a key/config file, through a
proxy, while executing a shell tool and producing machine-readable results.
Keep the adapter narrow: briefing in, progress/tool events out, exactly one
terminal disposition and artifact manifest. The platform, not harness tool
permissions, enforces file/network/resource boundaries.

**Main risk:** release churn and hidden network/process behaviour. The probe
was installed 1.19.0, while source review includes stable 1.19.3; no real model,
long-running resume, stop/process-tree cleanup or Kubernetes run was tested.
Its event stream is not a durable task-result protocol by itself.

**Would change it:** a pinned workbench fails no-key/proxy, offline startup,
resume/cancel or result-contract tests with the actual gateway, or DeepSeek /
prime-agent demonstrate the same strict gates without a fork and materially
better task behaviour. Codex becomes competitive if the gateway explicitly
supports the Responses API. No harness is accepted for deployment by this note.

## 3. S3 store for output and artifacts

### 3.1 Criteria and comparison

RustFS and SeaweedFS, with Garage briefly: single-node k3s fit on the 11 GB dev
machine; idle and loaded memory; manifests/Helm and persistence; put/get/list/
delete/presigned GET; scoped short-lived access; licence, maturity and backup.

### 3.2 Credential custody: STS, policies and presigned URLs

A short-lived STS access key is still a key inside a task. Native STS support
alone does not satisfy the owner's no-key requirement. Compare server-side
policy support separately from gateway-mediated signing and presigned requests.
The core/gateway can hold authority and mint task-prefix-bound access without
handing the signing secret to the task. The design must decide the exact seam.

### 3.3 Bounded local probes

Pending. At most two S3 images, under 2 GB total pulls, no cluster changes,
containers removed after use, no credentials or signed URLs in retained output.

### 3.4 Recommendation, main risk, and evidence that would change it

Pending the source review and probes.

## 4. For the lifemodel-653 design

- Define the harness-neutral briefing, progress, result and cancellation contract.
- Resolve no-key access, proxy identity, permissions and artifact publication.
- Decide artifact retention, quotas, backup/restore and cleanup failure semantics.
