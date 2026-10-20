# Research: the harness inside a task and its S3 artifact store (lifemodel-653.4)

Date: 2026-10-20. Round 2 re-evaluates the harness after the owner's
2026-10-20 clarification: a mounted provider config is allowed; no **real** key
may enter a task, but an ignored fixed placeholder is allowed. Round-1 strict
config/key judgements below are being replaced, not new deployment acceptance.
The round-2 Prime Agent pin is **0.10.1-beta.38**, Linux x64, bundled commit
`58f9e8bb0ef54956e2e796ef96723f20b43fc55d`, from the `nightly` release assets
(updated 2026-10-19). Its archive SHA-256 is
`d9510643a91cb2a4b3b44a92a51a57395985a725b7e2a121228b9796ecb1bb67`, verified
locally against the published beta manifest. Stable is still 0.10.0; this beta
is not a 1.x release. Scope: the replaceable harness inside one Kubernetes Job,
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

The first choice remains **OpenCode**, provisionally, for its already-probed
stable headless path and simpler non-Python task runtime. **Prime Agent
0.10.1-beta.38 is now a demonstrated alternative**, not a config/key failure:
round 2 passed its local shell, JSON result, HTTPS proxy/CA, resume and abort
checks with mounted config and an ignored placeholder. Pi and configured
DeepSeek also pass the revised config criterion by source evidence. This is
not a coding-model ranking: the local model was a scripted stub.

Besides the required prime-agent and DeepSeek candidates, include OpenCode,
Codex CLI and Pi. They cover three useful integration shapes: a provider-neutral
headless CLI with JSON events, a vendor-maintained compiled coding CLI, and the
small SDK/RPC harness from which prime-agent forked. All have current first-party
repositories and releases, rather than an abandoned demo. The release links and
per-candidate evidence below substantiate that shortlist; no popularity ranking
or coding benchmark was used.

### 2.2 Comparison at a glance

**Round-2 criterion:** endpoint and model may be set by a mounted provider
config (for example a ConfigMap) or environment. **No real key** means no model
credential carrying authority enters a task. An ignored fixed placeholder is
allowed, even when sent as `Authorization: Bearer ...`; absent Authorization
is not a hidden requirement. Round 1 instead required env-only configuration
and no dummy key, which wrongly excludes valid candidates under the owner's
new rule. Short-lived storage signing keys remain keys (part 3).

| Candidate / evidence version | One briefing, tools, progress and result | Custom endpoint + mounted config/env, no real key | Proxy, resume and stop | Licence / maturity / footprint |
|---|---|---|---|---|
| **prime-agent 0.10.1-beta.38 probed** (Rust; 0.9.8 historical evidence below) | `--print --mode json @briefing`; `python_repl` → shell; tool/text/turn events and terminal assistant in `agent_end` passed | **Pass, probed.** `models.json` selects Chat Completions base URL; `settings.json` selects provider/model. Requires ignored placeholder; sends Bearer placeholder. Omitting it gave no available model | **Probed** HTTPS_PROXY + NODE_EXTRA_CA_CERTS, saved-session resume, RPC abort, SIGTERM. Simple print run reported no background service | MIT; Rust rewrite, **prerelease**, not 1.x. Archive **22,572,323 bytes**; unpacked release **66,499,656 bytes**, plus Python runtime/dependencies (not an image) |
| **DeepSeek Harness (`dsh`, 687f282 sources)** | Developer-preview headless profile takes stdin, emits JSON events and final result; shell/files | **Changed: source-supported pass via configured `llm-pi-ai`.** Mounted Cordis profile supplies OpenAI endpoint/model; placeholder through `apiKeyEnv` or Authorization header. Native default is still DeepSeek Messages with x-api-key | Documents HTTPS_PROXY/custom CA; named sessions, headless lifecycle need adapter mapping. Not locally re-probed | MIT; preview, not a settled production contract. No OCI image measured |
| **OpenCode 1.19.0 probed / 1.19.3 sources** | `run --format json`; shell/file tools; streamed tool/text/step events | **Pass, unchanged.** Inline env JSON or mounted JSON; custom `@ai-sdk/openai-compatible`, `baseURL`, omit `apiKey` entirely | HTTPS proxy + custom CA passed round 1. `--session` / `--continue`; server abort or terminate Job. Stop not locally exercised | MIT; active stable releases. Published 1.19.3 archive **60,716,380 bytes**; installed 1.19.0 payload **254,277,088 bytes**, before tools |
| **Codex CLI 0.163.0 sources** | `codex exec`, JSONL events and last-message output; shell/patch tools | **Config pass, protocol caveat unchanged.** Mounted TOML or `-c` custom no-key provider; **Responses API only**, not Chat Completions | Standard proxy/client configuration; `exec resume`; terminate process/Job. Not locally exercised | Apache-2.0; official OpenAI project. Linux x64 musl archive **112,589,966 bytes**, not final image size |
| **Pi 1.3.0 sources** | Print / JSON / RPC and SDK; shell/read/edit/write | **Changed: source-supported pass.** Mounted `models.json` sets OpenAI base URL/model with documented ignored dummy key | Standard proxy support; saved sessions, RPC abort. Standalone custom CA not locally established | MIT; upstream lineage, independently usable. Linux x64 archive **42,617,111 bytes**, not final image size |

Only Prime Agent was newly installed/model-probed in round 2. Other rows retain
the round-1 pins; this is not a claim they are still the newest releases.

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

**Round-2 release investigation and source pin.** The
[stable release API](https://api.github.com/repos/PrimeIntellect-ai/prime-agent/releases/latest)
still names **v0.10.0** (2026-10-09). The rolling
[nightly release](https://github.com/PrimeIntellect-ai/prime-agent/releases/tag/nightly)
and its [beta manifest](https://github.com/PrimeIntellect-ai/prime-agent/releases/download/nightly/beta.json)
name **v0.10.1-beta.38**, updated 2026-10-19T22:03:47Z. The evaluated binary's
bundled package manifest identifies source commit
`58f9e8bb0ef54956e2e796ef96723f20b43fc55d`; the nightly release body agrees.
The public version tag resolves to
`0b75b208f31ed35b051e49813ed90af32fbd5940` (release metadata), so the bundled
source pin and asset hash above identify this probe more precisely than the
mutable `nightly` URL alone. All 294 visible branches were listed, including
`main`, `beta` and Rust-port branches; tags and the pinned
[README](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/README.md)
provided no 1.x release. There is no root CHANGELOG.md or old
packages/coding-agent/CHANGELOG.md at the inspected Rust pin; release changes
live under `.changes/`. The owner may mean the rewrite, but that intent is
unconfirmed. **This note evaluates beta.38, not an alleged version 1, and does
not claim the same probes for stable 0.10.0.**

The pinned Rust [custom-model parser](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-core/src/models/custom.rs),
[settings types](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-core/src/settings/types.rs)
and [print/RPC runner](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-cli/src/print_runtime.rs)
are the relevant implementation, not 0.9.8's TypeScript guide. The
[OpenAI source](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-ai/src/providers/openai_completions/mod.rs)
still checks key presence, but an ignored literal now meets the owner's rule.
The [TLS client](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-ai/src/utils_inner/tls.rs)
loads native roots and `NODE_EXTRA_CA_CERTS` once per process. Both config and
TLS claims were exercised below. The pinned README explicitly warns that
workers/kernels are **not** a sandbox; Kubernetes must supply that boundary.

The [kernel bootstrap](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-core/src/kernel/bootstrap/mod.rs)
needs the bundled `prime-agent-runtime`, a snapshot package and default Python
packages (including numpy/pandas/scipy). First-run bootstrap normally needs
network; `PRIME_AGENT_KERNEL_PYTHON` can select a pre-provisioned interpreter.
The probe used that stock override and disabled skill discovery; bundled Python
skills were not installed and generated explicit unavailable-skill warnings.
Thus shell support passed, **not** every bundled skill or subagent capability.
Bake the runtime/dependency lock into the workbench; a small Rust archive is
not the complete agent footprint. Print/RPC tests here used no background
daemon; interactive/daemon shutdown semantics remain a separate surface.

**DeepSeek identity.** The official
[DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/README.md)
identifies `dsh` as developed by DeepSeek AI and warns that it is developer
preview; its [licence](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/LICENSE)
is MIT. This is the candidate used here, not
[DeepSeek-Coder](https://github.com/deepseek-ai/DeepSeek-Coder), a model family,
or the community [DeepSeek CLI](https://github.com/holasoymalva/deepseek-cli),
[Deep Code CLI](https://github.com/lessweb/deepcode-cli), or former
[DeepSeek-TUI, now Codewhale](https://github.com/Hmbown/DeepSeek-TUI).
The owner's wording did not identify a URL; this report makes the choice
explicit rather than claiming to know which older tool was intended.

The source reviewed is main commit
`687f282e8625c6b8d11ff58211a90524be2e4317`, not a stable release contract.
Its [headless profile](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/headless/README.md)
accepts `dsh --profile headless <briefing>` or stdin, waits for child work,
flushes and exits. `--json` emits session/status/text/thinking/tool_call/
tool_result/final events; text is committed-step, not token-stream progress.
Completed work exits 0; error/abort/no-turn exits 1. The
[native auth plugin](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-deepseek-api-key/src/index.ts)
requires `DEEPSEEK_API_KEY`; overriding `DEEPSEEK_BASE_URL` does not change
its Messages wire protocol. Generic OpenAI providers use
[llm-pi-ai](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm-pi-ai/README.md)
configuration in a Cordis patch file. **Round-2 change:** that mounted file is
now allowed. The same guide explicitly says an unauthenticated OpenAI route
needs a placeholder through `apiKeyEnv` or an Authorization entry in `headers`.
Use a fixed ignored value, never a real credential. This is a source-supported
config pass without a fork, not a new local headless/proxy pass. The native
DeepSeek route is still the wrong wire protocol for a Chat Completions gateway.

The [base composition](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml)
includes bash/files/skills/subagents/jobs. The
[proxy guide](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/user/guide/network-proxy.md)
documents proxy variables and `NODE_EXTRA_CA_CERTS`, but some generated worker
code uses direct networking. The
[CLI lifecycle reference](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/reference/README.md)
defines exact `--session-id` resume and a five-second first-signal teardown;
SIGTERM may exit 0 without task success. It also describes a separate native
session-log upload contributor: **disabling OTel alone does not disable session
log uploads**, even through a configured gateway. A task-private profile must
remove that contributor. These are reasons to test a custom profile carefully,
not to treat preview headless support as unusable.

**OpenCode.** Stable 1.19.3 at
`e3c4eb242585dcd77be1a867391b7c25fd47ce52` supplies
[custom-provider examples](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/web/src/content/docs/providers.mdx)
without `apiKey`; the
[provider loader](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/provider/provider.ts)
loads configured custom providers without requiring stored auth. Its
[pinned generic SDK](https://github.com/vercel/ai/blob/99327b1d7b3d172ed0aae7230ae153f2d32b0ebb/packages/openai-compatible/src/openai-compatible-provider.ts)
adds Authorization only when an API key is supplied. Use a custom provider ID,
not the built-in OpenAI provider's authentication route. The
[config loader](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/config/config.ts)
accepts inline environment JSON and avoids seeding the default global config
when it is supplied. The
[runner](https://github.com/anomalyco/opencode/blob/e3c4eb242585dcd77be1a867391b7c25fd47ce52/packages/opencode/src/cli/cmd/run.ts)
emits step/tool/text/error JSON events. A `step_finish` is only a model step;
the adapter must inspect terminal assistant completion **and** process/error
state. The [server API](https://opencode.ai/docs/server/) has session messages,
SSE and `POST /session/:id/abort`; CLI supports session continuation and
export/import. Process-tree cleanup and crash replay still require testing.
[MIT licence](https://github.com/anomalyco/opencode/blob/v1.19.3/LICENSE);
[release and asset sizes](https://api.github.com/repos/anomalyco/opencode/releases/latest).

**Codex CLI.** Stable 0.163.0 at
`83086188ae0614bd882818ff1aa23f3194962012` documents
[noninteractive exec](https://developers.openai.com/codex/noninteractive):
briefing by argument/stdin, JSONL turn/item events, stderr progress,
`--output-last-message`, shell/file changes and session resume. The
[provider source](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/model-provider-info/src/lib.rs)
permits custom providers without `env_key`/OpenAI auth, but its wire enum is
Responses only and explicitly rejects removed `chat`. Repeated
[`-c` overrides](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/utils/cli/src/config_override.rs)
can define a provider and env-derived base URL without `config.toml`; that is
launcher-generated configuration, not a universal endpoint-env-only shortcut.
**Round 2:** a mounted `~/.codex/config.toml` is also acceptable. Removing the
config restriction does not add Chat Completions support.
The [proxy client](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/http-client/src/outbound_proxy.rs)
uses standard proxy variables; its
[custom CA support](https://github.com/openai/codex/blob/83086188ae0614bd882818ff1aa23f3194962012/codex-rs/http-client/src/custom_ca.rs)
uses `CODEX_CA_CERTIFICATE` / `SSL_CERT_FILE`, not Node's CA variable.
[Apache-2.0 licence](https://github.com/openai/codex/blob/rust-v0.163.0/LICENSE);
[release metadata](https://api.github.com/repos/openai/codex/releases/latest).
No local proxy or shutdown claim is inferred from those sources.

**Pi.** Stable 1.3.0 at
`71023aec1546d6d677a65669c5665c0927ce0dd0` has
[print/JSON/session controls](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/cli.md),
[custom model files](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/models.md)
and a [key gate](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/ai/src/api/openai-completions.ts).
**Round-2 change:** the guide's explicit dummy-key example meets the relaxed
rule with mounted `models.json`; the gateway must ignore it. This source-level
pass does not establish local tool/proxy/CA behaviour for Pi 1.3.0.
Its [HTTP dispatcher](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/src/core/http-dispatcher.ts)
uses an environment proxy agent; the standalone binary's custom-CA behaviour
was not verified. The
[JSON protocol](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/json.md)
says wait for `agent_settled`, not `agent_end`, because retries/queued work may
follow an end. [RPC commands](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/rpc-commands.md)
include abort and abort_bash. Its
[security guide](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/docs/security.md)
explicitly says there is no built-in sandbox. The current
[package manifest](https://github.com/badlogic/pi-mono/blob/71023aec1546d6d677a65669c5665c0927ce0dd0/packages/coding-agent/package.json)
uses `@earendil-works/pi-coding-agent` (repository now redirects to
`earendil-works/pi`); the old npm package name is not interchangeable.
[MIT licence](https://github.com/badlogic/pi-mono/blob/v1.3.0/LICENSE);
[release assets](https://api.github.com/repos/badlogic/pi-mono/releases/latest).

**Footprint limit of this comparison.** No harness image was pulled or built.
Archive sizes are release API metadata, installed byte counts are filesystem
observations, neither is OCI image size or idle memory. DeepSeek's complete
installed/image footprint was not established. Prime's Python kernel and every
candidate's shell toolchain, dev dependencies, CA store and session runtime
must be included in the eventual single-workbench build measurement. Do not
compare a tiny npm installer wrapper with another project's complete binary.

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

### 2.4.1 Round-2 Prime Agent probes (0.10.1-beta.38)

Downloaded the official Linux x64 archive into an untracked throwaway directory
**inside this worktree** and verified its SHA-256 against `beta.json` and the
GitHub asset digest. Unpacked it directly as a standalone release; never ran
the global installer/update command. The installed 0.9.8 binary and real
`~/.prime` were untouched. All CLI runs used `timeout`, a sanitized `env -i`,
a temporary HOME/XDG tree and an empty work directory, with startup network
operations disabled by `--offline` and telemetry disabled. Model traffic used
only local scripted mocks, never a real model. Runtime dependencies were
provisioned separately with bounded `lifemodel-heavy uv` commands, not fetched
during the agent turn. No cluster, VM or product-test commands ran.

Mounted-file equivalent (same stock files, also exercised mode 0444; this was
not an actual Kubernetes mount):

```json
// $HOME/.prime/agent/models.json
{"providers":{"probe":{"baseUrl":"http://127.0.0.1:<port>/v1","api":"openai-completions","apiKey":"ignored-placeholder","models":[{"id":"probe"}]}}}
// $HOME/.prime/agent/settings.json
{"defaultProvider":"probe","defaultModel":"probe","telemetry":{"enabled":false},"traces":{"enabled":false}}
```

Representative launch, with `<release>`/`<home>`/`<python>` under the throwaway
directory and only explicit environment values (no inherited provider keys):

```text
timeout 40s env -i HOME=<home> PATH=<tool-path> XDG_CONFIG_HOME=<home>/.config XDG_CACHE_HOME=<home>/.cache PRIME_AGENT_KERNEL_PYTHON=<python> DO_NOT_TRACK=1 PRIME_AGENT_TELEMETRY_DISABLED=1 <release>/prime-agent --offline --no-skills --no-prompt-templates --no-context-files --no-themes --cwd <empty-workdir> --provider probe --model probe --mode json --print @<briefing.txt>
```

The successful shell mock sent a streamed Chat Completions `python_repl` call
with `{"code":"print((await bash('printf R6534B_TOOL_OK')).output)"}`, then a
final text response after receiving the tool result. Each successful cycle
used two POSTs to `/v1/chat/completions`, model `probe`, with
`Authorization: Bearer ignored-placeholder`. The mock never validated that
value: it conveys no authority. Endpoint lived in `models.json`; a separate
run omitted CLI `--provider/--model` and used `settings.json` successfully.

| Probe (bounded foreground CLI) | Own exit / observed result | Meaning / limit |
|---|---|---|
| `timeout 15s ... --version` / `--help` | 0 / 0; **0.10.1-beta.38** | Correct throwaway binary, Rust package manifest/source pin above |
| `timeout 30s ... --print --mode json`, omit apiKey | **1**, `No models available`; zero mock requests | A placeholder is required for this custom route; not credential-free in the old no-dummy sense |
| `timeout 40s ... --print --mode json`, placeholder + shell | **0**; `tool_execution_start/update/end`, tool result `isError=false`, stdout `R6534B_TOOL_OK`; final assistant `R6534B_MOCK_OK`, `stopReason=stop`, `agent_end` | One-shot briefing, actual shell execution and JSONL progress/result pass |
| `timeout 15s ...`, mode-0444 config, no provider/model arguments | **0**; selected `probe/probe`, final result | Stock mounted-config shape supplies endpoint and model; actual ConfigMap mount not tested |
| `timeout 30s ...`, HTTPS_PROXY + NODE_EXTRA_CA_CERTS | **0**; two CONNECTs and two HTTPS model requests; shell and final cycle passed | Local proxy maps `model.probe.invalid:443` to TLS mock; CA signed a separate non-CA server certificate |
| `timeout 15s ...`, same proxy/valid leaf but no custom CA | **0**, terminal assistant `stopReason=error`, `Connection error.`; no successful model result | Negative trust control; **exit 0 is not task success** |
| `timeout 20s ... --mode rpc`, abort after mock receives request | **0** after input EOF; prompt ack then abort ack `success=true`, terminal `stopReason=aborted`, `Request was aborted`, `agent_end` | In-flight model cancellation passed. Prompt ack alone is not completion. No long-running shell/subagent cancellation tested |
| `timeout --signal=TERM --kill-after=2s 2s ... --print` while mock holds reply | **124**; request received; process ended in about 2 seconds | Simple client stop passed; timeout status is not a normal final result. No hostile descendant/cgroup proof |
| `timeout 15s ... --resume <saved-id> --print ...` | **0**; prior tool message present in next model request; final result | Saved conversation resume passed, not transactional shell replay or cross-Job recovery |
| `timeout 10s ... status`, then process-name inspection | **0**, `No background services found`; no remaining throwaway CLI/kernel process | This print/RPC route did not require a resident service; says nothing about interactive daemon mode |

Two setup controls failed before the final successful cases. A venv invocation
naming `/usr/bin/python3` failed (exit 2) because this NixOS host has Python at
`/run/current-system/sw/bin/python3`; corrected, provision succeeded. The
first shell attempt then found installed numpy/pandas/scipy unimportable under
`env -i` because `libstdc++.so.6` was absent from the loader path. Supplying the
host's explicit `NIX_LD_LIBRARY_PATH` as `LD_LIBRARY_PATH` fixed it; no agent
source changed. That failed tool still led to final mock text and exit 0:
**a final answer cannot erase an earlier failed required effect**. Production
must include native libraries, not copy this host-specific loader path.

The initial TLS fixture reused a self-signed CA certificate as the server leaf;
Python's urllib control accepted it (200) but Prime's Rust TLS rejected it
(`Connection error.`, CLI 0). With a proper signed leaf, the CA-positive test
passed and CA-negative test failed as expected. This was a fixture correction,
not evidence that disabling verification is needed. Verification stayed on.
The transcript contains full tool/message bodies; normalize/redact progress
before forwarding it into product logs. The Rust [RPC tests](https://github.com/PrimeIntellect-ai/prime-agent/blob/58f9e8bb0ef54956e2e796ef96723f20b43fc55d/crates/pa-cli/tests/rpc_mode_e2e.rs)
also cover abort/event ordering, but were read, not run here.

Unpacked release files total **66,499,656 bytes** before execution; the probe's
separate 50-package Python venv was about **274.5 MB** (logical file sizes,
Python 3.14.7 host interpreter, no bundled Python skills). Neither is an OCI
size, RSS measurement or reproducible production dependency lock. No current
stable-0.10.0, real-gateway/model, tool-network, skill, long-run or Kubernetes
acceptance is claimed. All mock listeners were closed, TLS private keys and
the throwaway release/HOME/venv removed after recording results.

### 2.5 Recommendation, main risk, and evidence that would change it

**Recommend OpenCode as the first harness adapter**, still provisionally,
pinned and baked into the one workbench image. The reason is now its stable
headless path already demonstrated in round 1 and simpler non-Python runtime,
**not** exclusive compliance with no-config/no-dummy rules that no longer
apply. **Prime Agent beta.38 is a credible second adapter**, with the same
local shell/JSON/proxy gates plus newly exercised abort/resume. Its smaller
release archive does not remove its substantial Python runtime/dependencies.
Pi and configured DeepSeek stay on the shortlist; their relaxed config pass is
source-supported, not yet locally demonstrated. Codex still needs Responses
support at the gateway.

Keep the adapter narrow: briefing in, bounded progress/tool events out,
exactly one terminal disposition and artifact manifest. The platform, not
harness tool permissions, enforces file/network/resource boundaries. Normalize
Prime's `error`/`aborted` stop reasons and failed required tool effects; neither
CLI 0 nor `agent_end` alone is a success contract.

**Main risk:** release churn and hidden network/process behaviour. Prime's
rewrite is only probed at a prerelease; the stable release was not substituted
as if equivalent. OpenCode's existing local probe is 1.19.0 while source review
includes 1.19.3. No actual gateway, real model, pinned full workbench, long-run
process-tree cleanup or Kubernetes run was accepted. JSON events are not a
durable task-result protocol by themselves.

**Would change it:** prefer Prime if the chosen production pin (stable or an
explicitly accepted beta) passes the actual gateway, fully offline baked
runtime, real tool-heavy task, terminal-error normalization and bounded
process-tree cancellation tests, and RLM/skills materially improve that task.
The new probes already remove the previous authentication/config objection;
requiring no placeholder or no config again would reinstate a rejected gate.
Pi/DeepSeek can win on equivalent runtime evidence and simpler integration.
A failure of OpenCode on the real gateway, cancel/result contract or offline
startup also reopens the choice. No harness is accepted for deployment here.

## 3. S3 store for output and artifacts

### 3.1 Recommendation and comparison at a glance

**Recommend SeaweedFS 4.48 behind the credential-custody gateway**, with RustFS
1.0.3 as a serious, lighter measured alternative. Both passed the basic local
S3 checks. SeaweedFS wins provisionally on longer project history, explicit
released prefix-authorization tests and documented backup mechanisms, not on
resource use. Neither has a complete restore or hostile STS policy proof here.

| Criterion | RustFS 1.0.3 | SeaweedFS 4.48 | Garage 2.4.1, briefly |
|---|---|---|---|
| Required S3 operations | PUT/GET/LIST/DELETE, presigned GET/PUT passed local probe | Same, passed local probe | Documented basic operations and presigned URLs; not locally probed |
| Task-prefix authority | IAM/bucket policies; STS AssumeRole and web identity; inline session-policy intersection | IAM roles/trust policies; STS and OIDC; inline session-policy intersection with request-level prefix tests | Per-key-per-bucket permissions; no S3 bucket policy support or established STS path; broker or per-task buckets required |
| No signing key in task | Broker keeps signer/STS secret; per-object presigns or proxy bytes | Same | Broker holds bucket key and enforces prefix itself |
| Single-node k3s | Standalone server/PVC; official chart, distributed defaults must be overridden | `weed mini` single process/PVC or deliberate allInOne/separate-components chart; disable extra services | Helm singleNode mode exists; metadata and object PVCs distinct |
| Measured idle / load sample | **56.41 / 130.1 MiB** | **75.36 / 400.9 MiB** | Not measured |
| Download / unpacked image | **114,586,435 / 416,415,587 bytes** | **193,556,478 / 723,701,924 bytes** | Not pulled |
| Licence / maturity | Apache-2.0; stable 1.0.3, younger operational history | Apache-2.0; stable 4.48, much longer project history; new IAM features still need tests | AGPLv3; established small/distributed-store focus, policy mismatch here |
| Backup concern | Objects plus IAM/config; replication alone is not historical backup; restore drill absent | Volume + filer metadata + IAM/config; built-in backup surfaces, complete restore drill absent | Metadata snapshot alone is not object backup; one replica cannot heal from a lost disk |

Sources and qualifications follow. Memory values are Docker working-set samples,
not provisioned requests, exact process RSS, maxima or a total k3s budget.

### 3.2 RustFS evidence

**Version, API and maturity.** The
[1.0.3 release](https://github.com/rustfs/rustfs/releases/tag/1.0.3)
is marked stable, published 2026-10-17, and resolves to
`331fb896285a7686f927baf8d9d4dc2d3d3a10a9`; the local image reports that
version/commit. It is not accurate to dismiss the current product as alpha.
The [repository metadata](https://api.github.com/repos/rustfs/rustfs) records
creation in 2023; this is relative project history, not an uptime guarantee.
Its [licence](https://github.com/rustfs/rustfs/blob/1.0.3/LICENSE) is Apache-2.0.
The [compatibility matrix](https://github.com/rustfs/rustfs/blob/1.0.3/docs/architecture/s3-compatibility-matrix.md)
limits compatibility to implemented S3 features; the
[presign negative tests](https://github.com/rustfs/rustfs/blob/1.0.3/crates/e2e_test/src/presigned_negative_test.rs)
cover expiry/tampering. Local observations below cover the operations needed
here, not all of AWS S3.

**STS and prefix policies.** The official
[STS guide](https://github.com/rustfs/docs.rustfs.com/blob/8d4806d906bd5c8b8ab5209f7f4e15e10e8aa4b8/content/en/security-compliance/iam/sts.md)
and [released handler](https://github.com/rustfs/rustfs/blob/1.0.3/rustfs/src/admin/handlers/sts.rs)
describe AssumeRole and AssumeRoleWithWebIdentity. Ordinary AssumeRole is
SigV4-authenticated by a long-term caller; it inherits the caller's policy
bindings. `RoleArn`, session name and ExternalId are compatibility fields,
not evidence of AWS's complete cross-account trust model. An inline `Policy`
can narrow the session. Omitting it keeps inherited scope: the broker must
supply it, never accept arbitrary policy JSON from a task. The
[IAM authorization source](https://github.com/rustfs/rustfs/blob/1.0.3/crates/iam/src/sys.rs)
combines parent and session policy; the
[policy engine](https://github.com/rustfs/rustfs/blob/1.0.3/crates/policy/src/policy/policy.rs)
includes bucket-resource ListBucket prefix-condition tests. These files were
opened independently when validating the research findings.

An object statement uses `arn:aws:s3:::artifacts/tasks/<id>/*`; a separate
ListBucket statement uses `arn:aws:s3:::artifacts` with a `s3:prefix` condition.
Putting the object-prefix ARN on ListBucket is not equivalent. Use literal,
trusted task IDs and a defined key canonicalization rule, not task-chosen
wildcards. This policy shape is a design inference from the released evaluator;
actual STS authorization was not exercised locally.

Default duration is 3600 seconds; nonzero requests are **clamped to 900–43200
seconds**. Asking for a 60-second session does not give a one-minute session.
OIDC needs configured issuer/audience/JWKS and policy mapping; a projected k3s
token is not automatic integration. See the
[OIDC requirements](https://github.com/rustfs/rustfs/blob/1.0.3/docs/operations/oidc-provider-requirements.md).
Derived service accounts and STS triples still carry signing secrets; they
belong at the broker, not in a keyless task.

**Deployment and persistence.** The
[released Helm values](https://github.com/rustfs/rustfs/blob/1.0.3/helm/rustfs/values.yaml)
expose standalone mode, existing Secret/PVC and resource settings, but default
to distributed topology. Select standalone explicitly; four replicas on one
host do not create four failure domains. The
[SNSD instructions](https://github.com/rustfs/docs.rustfs.com/blob/8d4806d906bd5c8b8ab5209f7f4e15e10e8aa4b8/content/en/installation/linux/single-node-single-disk.md)
and [released README](https://github.com/rustfs/rustfs/blob/1.0.3/README.md)
warn that one disk has no redundancy and SNSD does not expand in place into
a pool. Resource examples and a benchmark machine's RAM are not idle minima.
Persist the data and configuration/custody state; use explicit limits and
single-writer update semantics. The local disposable container's writable
layer was only a probe, not the proposed persistence model.

**Backup.** [Site replication operations](https://github.com/rustfs/rustfs/blob/1.0.3/docs/operations/site-replication-operations.md)
distinguish RustFS IAM/control-plane replication from generic S3 bucket
replication. A generic replica does not preserve IAM; replication also does
not protect against every authorized delete. No complete single-node restore
recipe was proven here. Require a consistent offline volume backup or logical
object export **plus** IAM/policy/configuration/custody backup, and verify it
on an empty instance. This requirement is a design recommendation, not a
claimed successful restore. Docs about using RustFS as a backup destination
do not establish how to back up RustFS itself.

### 3.3 SeaweedFS evidence

**Version, API and maturity.** The
[4.48 release](https://github.com/seaweedfs/seaweedfs/releases/tag/4.48)
is marked stable and resolves to
`530be3e37337488ecc34d58441e0bc476e121c93`; the local image reports
`4.48 530be3e37`. The
[repository metadata](https://api.github.com/repos/seaweedfs/seaweedfs) dates
creation to 2014. That longer history is a reason to investigate it first,
not proof its newer IAM paths have a decade of use. Its
[licence](https://github.com/seaweedfs/seaweedfs/blob/4.48/LICENSE) is Apache-2.0.
The [S3 API table](https://github.com/seaweedfs/seaweedfs/wiki/Amazon-S3-API)
records supported and missing operations. Required basic operations and
presigned GET/PUT passed this run.

**STS, OIDC and real authorization.** The
[advanced IAM/OIDC guide](https://github.com/seaweedfs/seaweedfs/wiki/OIDC-Integration)
separates basic identities in `s3.config` from advanced IAM in `s3.iam.config`.
A basic static-key demo does not enable the intended advanced flow. STS supports
AssumeRole and web identity; the released
[STS service](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/iam/sts/sts_service.go)
and [IAMManager](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/iam/integration/iam_manager.go)
carry the session policy and require **both** base and session policies to
allow the action. The
[prefix regression tests](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/s3api/iam_list_prefix_regression_test.go)
explicitly allow `warehouse/*`, deny `secrets/`, and preserve the bucket ARN for
ListBucket. The [request middleware](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/s3api/s3_iam_middleware.go)
maps the query prefix into `s3:prefix`. These source files were independently
opened before relying on this recommendation. Use object ARNs and a separate
bucket-level prefix condition as for RustFS; session names alone confer no
prefix confinement.

The [STS constants](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/iam/sts/constants.go)
and service use default 3600 seconds, minimum 900, configurable maximum
(default 43200). Source OIDC-token expiry does **not** cap the new STS session.
The [SigV4/presign verifier](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/s3api/auth_signature_v4.go)
checks session expiration as well as URL signature/time. OIDC requires explicit
issuer, audience, JWKS/CA and role-trust mapping. Gateway replicas must share
STS issuer/signing key. Immediate individual revocation is not promised here:
the integration has optional revocation storage, whose actual deployment
wiring must be proven. Short URLs are not automatically instantly revocable.

**Single-node k3s shape.** Released
[`weed mini` flags](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/command/mini.go)
provide master, volume, filer and S3 in **one process**, so “more parts” need
not mean four pods on the dev machine. It also starts optional services; disable
WebDAV/admin/catalog ports not needed and keep underlying filer/master/volume
ports unreachable from tasks. Without credentials it can allow anonymous
access; fail startup if custody config is missing. A prefix policy is useless
if a task can bypass S3 and reach an unprotected filer.

For the first single-node design, consider a small pinned `weed mini`
StatefulSet with one persistent data volume and explicit flags, or render the
[official chart](https://github.com/seaweedfs/seaweedfs/blob/4.48/k8s/charts/seaweedfs/values.yaml)
in deliberate allInOne mode. **Do not deploy chart defaults unchanged:**
allInOne is disabled, its S3/auth toggles are disabled, and its data type is
`emptyDir`. Set PVC/existingClaim, auth and a single-writer/Recreate rollout;
read the rendered command, because chart allInOne is not necessarily `mini`.
The chart allInOne 1 GiB request / 2 GiB limit is a default, not measured need.
If splitting components, persist master state, volume data **and filer
metadata**. The [chart README](https://github.com/seaweedfs/seaweedfs/blob/4.48/k8s/charts/seaweedfs/README.md)
warns of losing filer metadata. One physical disk still has no redundancy.

**Backup.** Released
[`weed backup`](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/command/backup.go)
backs up volume data/indexes;
[`filer.backup`](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/command/filer_backup.go)
streams changes to configured sinks and supports `-initialSnapshot` before
following updates; [metadata backup](https://github.com/seaweedfs/seaweedfs/blob/4.48/weed/command/filer_meta_backup.go)
is a separate surface. Preserve filer metadata and IAM/policy/role/config/
signing state too. A continuous mirror with deletes is not inherently an
immutable recovery point. No complete restore was run. The design needs a
fresh-instance recovery drill checking both hashes and wrong-prefix denial.

### 3.4 Garage, briefly

Garage [2.4.1](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/tag/v2.4.1)
has [basic S3 operations and presign support](https://github.com/deuxfleurs-org/garage/blob/v2.4.1/doc/book/reference-manual/s3-compatibility.md),
but explicitly uses per-key-per-bucket permissions rather than S3 ACLs/policies.
No native STS/OIDC session-policy mechanism was established from its
[feature documentation](https://github.com/deuxfleurs-org/garage/blob/v2.4.1/doc/book/reference-manual/features.md).
Thus it cannot supply the same native shared-bucket task-prefix boundary;
a bucket per task or a broker authorizing every operation would be needed.
Its [Helm chart](https://github.com/deuxfleurs-org/garage/blob/v2.4.1/script/helm/garage/values.yaml)
has singleNode mode and separate metadata/data PVCs, so it is **not** rejected
for lacking Kubernetes support. The mismatches are authorization shape and
[AGPLv3](https://github.com/deuxfleurs-org/garage/blob/v2.4.1/LICENSE) versus
the other candidates' permissive licences. AGPL carries licensing/source-availability obligations, including for some
modified network services; it is not evidence of unsafe code. Its [recovery guide](https://github.com/deuxfleurs-org/garage/blob/v2.4.1/doc/book/operations/recovering.md)
does not make metadata-only snapshots sufficient for object recovery or turn
one replica into disk redundancy. No image or runtime probe was spent on it.

### 3.5 How the core and gateway mint task-prefix-bound access

**STS credentials are still keys.** Issuing a short-lived access-key/secret/
session-token triple to a pod does **not** meet the owner's no-key requirement.
OIDC avoids a static key only after configuring trust, and a token is still a
capability. This is a design constraint derived from the protocols above,
not a feature any S3 server can solve alone.

Recommended custody arrangement (design inference, not implemented):

1. The core fixes an immutable task ID and `tasks/<id>/` prefix. The gateway
   authenticates the task by a platform-controlled identity/channel, never a
   task-supplied prefix, bucket or policy. The design must choose that identity;
   “no credentials” is not achieved merely by renaming a bearer token.
2. A trusted broker/gateway holds S3 signing authority outside task sandboxes.
   With RustFS or SeaweedFS it can assume a restricted per-task session and
   **keep the keys in custody**. Parent policy allows the appropriate bucket;
   session policy narrows object actions and ListBucket to this task. Garage
   needs broker-enforced prefix scope or a separate bucket, without equivalent
   native per-prefix STS defense in depth.
3. For an approved relative filename, the broker canonicalizes the full key,
   approves the operation and declared size, and issues a short-lived
   **single-method, single-object** PUT or GET presign. A host-only signed PUT
   does not itself enforce actual byte limits or quotas: require a supported
   signed/enforced constraint, byte proxying, or verification with rejection
   and cleanup before publication. All three stores support presigned GET;
   RustFS/SeaweedFS PUT/GET were tested. A presign is not a prefix-wide SDK
   credential. List/delete can be mediated by the gateway; multipart needs
   explicit create/upload-part/complete/abort handling rather than assuming a
   simple PUT URL covers it.
4. The owner authenticates to the product before the gateway mints a fresh
   download GET. Retain artifact IDs/object references, not signed URLs, in
   durable task records. URLs are bearer capabilities: no signing secret is
   disclosed, but anyone holding the URL can use it until expiry or underlying
   authorization/object invalidation. Never log URLs, headers or tokens or
   put them into prompts/history. If “no keys” also forbids bearer URLs in
   tasks, the gateway must proxy bytes instead.
5. Authorization goes task → gateway; data either goes through that proxy or
   to a narrowly allowed S3 route using the returned presign. This is not
   unrestricted cluster access. The design must resolve the owner's ban on
   arbitrary internal addresses with the chosen artifact route. A browser
   presigned URL must name a reachable, authenticated/exposed S3 route
   with exactly the signed host/path, or the web gateway must stream the bytes.
   Rewriting a signed URL's internal host to the public host after signing
   breaks SigV4; an internal-only store URL is not an owner download design.

Use exact prefix separation (`a/` versus `ab/`), trusted IDs, separate bucket
list conditions, bounded TTL and per-task quotas. Check policy/expiry on every
new capability. Already issued URLs and in-flight requests complicate Stop;
short TTL alone is not immediate revocation. The design must specify its bound.

### 3.6 Cheap local probes and reproducibility limits

All shell invocations used `timeout` and were awaited in the foreground from
the control session. HTTP calls used explicit request timeouts. No cluster/VM
changes or product tests were run. The S3 probe window was about five minutes,
well under thirty; only these two images were pulled. Sum of compressed layer
sizes from their selected platform manifests: **308,142,913 bytes** (about
294 MiB); even their summed unpacked size is below 2 GB. Registry metadata was
inspected **before** pulling. Mutable `latest` tags were resolved to immutable
Linux/amd64 manifests:

| Store | Exact probed image manifest |
|---|---|
| RustFS | `rustfs/rustfs@sha256:128220dc9382bac81940a1a9616ee8c274a3f3b8f647eedbeb50df5bb8b49922` |
| SeaweedFS | `chrislusf/seaweedfs@sha256:aba492e2a4e4c90bff795745e8e660affa1f09e7650f5981bd7bccd1a06cd931` |

Representative commands, with credentials deliberately omitted:

```text
timeout 20s docker manifest inspect <image-or-manifest>
timeout 90s docker pull <pinned-image>
timeout 15s docker create --name r6534-rust --memory 1g --cpus 1   -p 127.0.0.1:19340:9000 --env-file <private-ephemeral-env> <rust-image> /data
timeout 15s docker create --name r6534-sea --memory 1g --cpus 1   -p 127.0.0.1:19341:8333 -v <private-config>:/etc/sea-probe.json:ro   <sea-image> mini -dir=/data -ip=127.0.0.1 -master.telemetry=false   -admin.ui=false -webdav=false -s3.port.iceberg=0 -s3.port.lance=0   -volume.max=2 -s3.config=/etc/sea-probe.json
timeout 10s docker start r6534-rust
timeout 10s docker start r6534-sea
timeout 10s docker stats --no-stream --format <name/memory/cpu> r6534-rust r6534-sea
timeout 15s docker rm -fv r6534-rust r6534-sea
```

The random per-probe credentials were generated in memory and stored only in
mode-0600 local files for the services/signer, not printed or committed. This
is an administrative probe, **not** proof of keyless task uploads. Only S3 was
published, on loopback. Per-request HTTP timeout was eight seconds. A small
Python `requests`/`hmac` client implemented AWS SigV4, region `us-east-1`, S3
path-style addressing, signing `host;x-amz-content-sha256;x-amz-date`; presigns
signed `host`, used `UNSIGNED-PAYLOAD` and `X-Amz-Expires=60`. Thus no third
client image or project dependency install was needed. This was a protocol
smoke test, not the product SDK or conformance suite.

| Observation | RustFS | SeaweedFS |
|---|---|---|
| Create `r6534` bucket | HTTP 200 | HTTP 200 |
| PUT / GET `tasks/one/result.txt` | 200 / 200, exact bytes | 200 / 200, exact bytes |
| ListObjectsV2 with `prefix=tasks/one/` | 200 | 200 |
| Presigned GET, 60-second TTL | 200, exact bytes | 200, exact bytes |
| Presigned PUT | 200 | 200 |
| Change a signed PUT target to `tasks/two/` | 403 | 403 |
| DELETE uploaded objects | 204 | 204 |
| Idle after tiny requests | 56.41 MiB, 0.21% CPU | 75.36 MiB, 0.16% CPU |
| Load-time sample | 130.1 MiB, 49.84% CPU | 400.9 MiB, 83.78% CPU |

Load was **24 PUT+GET pairs per store**, objects **4 MiB**, a shared four-thread
client pool across the two stores, and one CPU / 1 GiB cap per service. All
48 pairs returned 200/200 and exact object lengths. The stores did not receive
an independently controlled identical concurrency schedule; the snapshot was
not a peak sampler or throughput benchmark. Docker cache accounting, startup,
index growth, multipart, sustained concurrency and larger artifacts can change
memory substantially. Do not set production limits to these samples. No OOM
or end-to-end latency claim is made.

The changed-key 403 proves **signature target binding**, not native STS
prefix-policy enforcement. The list probe checked HTTP success, not pagination
or hostile-prefix leakage. No STS/session expiry, restart persistence, backup,
disk-failure, multipart or recovery drill was run. Help probes exited 0 for
RustFS and 2 for SeaweedFS `mini -h` (it printed help); both one-shot containers
were removed by `--rm`. The two service containers and anonymous volumes were
removed with `docker rm -fv` (exit 0), then `docker ps -a --filter name=r6534`
returned no names. Credential files and mock TLS keys were deleted. Downloaded
image layers remain as a local cache; no service remains running.

### 3.7 Recommendation, main risk, and evidence that would change it

**Recommend SeaweedFS 4.48 first**, using a minimal single-node deployment and
broker-held per-task scope with per-object presigns/proxying. It has a longer
operational history, release-specific prefix tests and explicit volume/filer
backup tools. RustFS 1.0.3 is already stable and passed the same smoke test;
its much lower measured load sample makes it a credible alternative on the
11 GB dev machine. No source or probe proves the complete stack fits that
machine under realistic concurrent tasks; measure alongside k3s, Postgres,
Valkey, core, web and the workbench workload before assigning a store budget.

**Main risk:** SeaweedFS's extra internal services and distinct metadata/IAM
state make least privilege and complete recovery easier to get wrong. Newer
IAM features need the same hostile tests as RustFS. The chart's default
storage/auth settings are not safe retained-artifact defaults.

**Would change it:** a pinned RustFS run passes the real broker's allowed/denied
PUT/GET/LIST/DELETE/copy/multipart matrix, credential/URL-expiry tests and a
complete fresh-instance restore, while representative k3s load confirms a
material memory advantage; then prefer RustFS's smaller operating shape. Also
reopen if SeaweedFS cannot stay inside the agreed memory budget or preserve
prefix/metadata boundaries in recovery. Neither store is accepted by desk
research alone.

## 4. For the lifemodel-653 design

These are design inputs, not silently resolved requirements:

- **Wire and launch contract:** Chat Completions, Responses or both. The owner
  has now allowed mounted provider config (for example a ConfigMap) or env;
  do not reopen “no config file” or “no ignored placeholder” as requirements.
  Pin config schema and exact harness/image version; keep HOME/session state
  task-private, mount only non-secret endpoint/model/placeholder data, and
  bake entirely offline startup, including auxiliary/title models, plugins,
  Python/native libraries and toolchain. Prime beta.38 passed local mocks,
  not the production pin/gateway/workbench acceptance.
- **Harness seam:** immutable briefing plus tool/access-request events,
  bounded progress, one terminal success/failure/stopped disposition, artifact
  manifest validation and real-task acceptance. A final assistant turn alone
  is not task success. Prime's observed CLI 0 on provider error, failed tool and
  abort requires explicit JSON error/stopped normalization; match tool effects
  to required outcomes, and redact message/tool bodies in product progress.
  Prove a second fake adapter changes no caller.
- **Resume and Stop:** retained session state versus discarded work volume;
  no automatic replay of ambiguous shell effects; process-tree/cgroup cleanup,
  upload drain deadline and honest status if output cannot be retained before
  deleting a Job. A conversation resume is not transactional restart.
- **Identity and no-key scope:** how task identity reaches the gateway without
  another reusable key; where signing/STS/OIDC custody lives; whether bearer
  URLs are allowed or bytes must be proxied; which component actually mints
  them. No direct task access to store admin/filer/control ports.
- **Artifact contract:** canonical key rules, task-id separation, content type,
  allowed sizes, checksums, partial/multipart upload semantics, retries,
  pagination, overwrite/versioning, read-only final publication, per-task and
  global quotas, retention/deletion and a GC race with owner downloads.
- **Owner download route:** reachable public host signed before issuance or
  authenticated web streaming, CORS if applicable, short TTL, no URLs in logs,
  and the precise revocation/Stop bound for already-issued capabilities.
- **Storage deployment and recovery:** minimal topology and exposed ports,
  PVC size/class, encryption and custody, resource headroom within 11 GB,
  readiness/auth fail-closed checks, backup location outside the same failure
  domain, RPO/RTO, full objects+metadata+IAM restore and upgrade/rollback.
- **Required next evidence:** pinned workbench with actual gateway, proxy/CA,
  real tool-heavy task, resume/stop/error normalization and second adapter;
  real STS session restricted from parent A+B to A with negative B/root/empty
  prefix cases; prefix `a` versus `ab`, escaped/wildcard keys, copy/multipart,
  expired URL/session and fresh-instance restore. Signature tampering alone
  is not an authorization test. These are future design/acceptance checks.

No product behavior, cluster configuration, ADR or present-tense feature claim
was changed. Full isolated product checks are intentionally not required for
this research-only document; present-documents and backlog gates are reported
in the worker report. The automatic transition document gate is not installed
according to [the integration](../backlog-integration.md).
