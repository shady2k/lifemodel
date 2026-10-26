# Research: a second ACP task harness (lifemodel-653.9.1)

Date: 2026-10-26. Scope: a pinned second harness behind the existing generic
ACP client, not a new native adapter. This is a scripted-model compatibility
probe, not a coding-model benchmark or stage acceptance. No real model key or
owner gateway is used. No production code, registry or Dockerfile is changed.

## 1. Decision context and method

The owner requires an ACP-only harness layer. OpenCode v2.1.4 remains its first
configuration. The second candidate is goose or Prime Agent's Rust 0.10 line,
not the 0.9.8 executable installed on this machine. A startup egress call that
cannot be disabled, unreliable cancellation, or an ambiguous terminal result
is disqualifying. Missing ACP features are recorded; no native API is substituted.

The task brief and `br show lifemodel-653.9.1` were read. The stock workbench
was built locally at base `c4842fc0` using:

```sh
lifemodel-heavy docker build -f docker/workbench/Dockerfile -t probe-6539/workbench:stock .
```

It exited **0** (cached steps), image
`sha256:5fe107c1dd8f56870a658cda7a93ebddc9e41768ca089a3168a0113fa5184728`.
The [build receipt](task-harness-acp/evidence/workbench-build.log) retains the
command and image export. Every runtime run uses `--network none`, 1 CPU,
1 GiB and 256 PIDs. Only research-folder mounts are visible; no host config,
credentials or Docker socket is mounted. A fresh private task home is used.

The [scripts](task-harness-acp/README.md) place a TLS scripted OpenAI-compatible
stub and the **real compiled `createTaskModelRelay`** in the container's loopback
namespace. The stub requires no authority and returns a fixed shell tool call,
then fixed final prose. Relay auth is a fixed placeholder; its CA trusts only
the generated probe certificate. No outside network exception is needed: the
upstream is also loopback. `strace -f -tt -e trace=connect` records the model
route and other attempts. A network-none failure alone is not proof of no
attempted egress; the connect log matters.

The raw driver sends ACP v1 `initialize`, `session/new`, `session/prompt`,
`session/cancel`, and the real client's permission denial. It preserves native
stop reasons and updates. Separate `--client real` runs instantiate unchanged
compiled `AcpTaskHarness` from the workbench with probe-only launch configuration.
A successful driver exit only means evidence was collected, not that a candidate
passed. Assertions use marker files, shell PID liveness, ACP tool status, stop
reason and the real client result.

## 2. Pins and main-line provenance

The machine's installed executable and GitHub's Latest label were not used as
version evidence. The upstream tag source, main source, release workflow and
asset digest were inspected. All downloaded archives were locally SHA-256
checked against GitHub's published release-asset digests. The exact manifest is
[pins.json](task-harness-acp/pins.json).

| Candidate | Upstream source | Published Linux x64 archive SHA-256 |
|---|---|---|
| goose 1.56.0 GNU control | `9949cf926cd42f1d128b9991ed23a496ecace896` | `225a929b35b5130fb691eafdb50be236f2c0a150019b53973775938f8f19c281` |
| goose 1.56.0 musl portable | same source | `80e7716fef3dccc3fef6850e24e5b846b7340e10e13098e53b4f47769f5803ef` |
| Prime Agent 0.10.1 | `8aac8692456c00c01d4e53e60e6d3347a3506559` | `21ec219183f4134dd23dce9572102e69456066fe374846525561c776d4d1945c` |

Goose's `block/goose` now redirects to `aaif-goose/goose`. The release is built
from a **main-derived release branch**, not an exact ancestor of today's main.
Captured main was `0a2f30681566ec83e6359c375c7f5b36aa3567b2`; the release shares
merge base `b599156086b30c7902d4c4e553fa8f0789d6f9bb` and has three release-only
marker/build-fix commits. This qualification is explicit rather than hiding a
`compare` result of diverged. Prime 0.10.1 is an exact ancestor of captured main
`c4c238ca025e382d96fb5f37e6328ca77fb82ef3` (30 commits ahead, zero behind).
The [source review](task-harness-acp/source-review.md) links release workflows,
source and comparisons and distinguishes main-only fixes from the tested pins.

## 3. Runtime evidence

The [evidence directory](task-harness-acp/evidence/) contains exact commands,
exit codes, native results, trimmed ACP transcripts, connect traces and stub
request logs. [summary.json](task-harness-acp/evidence/summary.json) collects the
final runs. [network-summary.json](task-harness-acp/evidence/network-summary.json)
counts every `connect` attempt, including failed attempts, not just established
connections. The 21 retained runtime runs all exited **0** as evidence collectors;
the candidate pass/fail judgments below are separate.

### 3.1 Startup and model routing

**GNU goose fails check 1.** The published default GNU build includes
`online-model-meta`. Its main function starts a background models.dev catalog
refresh without a runtime opt-out. Naming, telemetry and keyring knobs do not
disable it. Its startup trace, before any prompt, contains four attempts like:

```text
29 17:57:41.304357 connect(11, {sa_family=AF_INET, sin_port=htons(53),
   sin_addr=inet_addr("192.168.0.30")}, 16) = -1 ENETUNREACH
```

This is a blocked DNS attempt, **not** proof of a successful models.dev HTTPS
connection. Source identifies the fetch. `GOOSE_DISABLE_UPDATE_CHECK` from the
inherited draft was removed: no such runtime control was found. The published
musl portable variant omits `online-model-meta` and update support at build time;
using that upstream release asset is not patching goose or substituting its API.

**Musl goose passes the observed startup/no-egress test.** Initialize and
session/new succeed. It performs model-list requests through the relay while
building the session configuration. The startup trace has four IPv4 connects,
all loopback; no non-loopback attempt. Across all retained musl tool, permission,
cancel and error runs, every IPv4 connection is loopback. There is no keyring or
D-Bus connection. The isolated config is supplied with:

```text
HOME=/work/probe/home                 TMPDIR=/work/probe/tmp
GOOSE_DISABLE_KEYRING=1               GOOSE_DISABLE_SESSION_NAMING=true
GOOSE_TELEMETRY_ENABLED=false         OTEL_SDK_DISABLED=true
GOOSE_PROVIDER=openai                GOOSE_MODEL=task
GOOSE_MODE=auto                       # approve in permission probes
OPENAI_BASE_URL=http://127.0.0.1:<relay-port>/v1
OPENAI_BASE_PATH=v1/chat/completions   OPENAI_API_KEY=probe-placeholder
```

Only PATH, private HOME/TMPDIR and these explicit values reach the agent. No
owner environment is inherited. The source also offers `GOOSE_PATH_ROOT`; the
probe did **not** need it because HOME was already private. No allowlist URL or
external extension was configured. Built-in developer/platform extensions and
bundled skills can appear in the session; the tool selected from the actual
model offer is **`shell`**, not an assumed prefixed name.

**Prime passes the observed startup/no-egress test after image-time packaging.**
The stock workbench can initialize/create its session without Python, but an
actual Python tool needs the release's bundled `prime-agent-runtime` and default
packages. [Dockerfile.probe](task-harness-acp/Dockerfile.probe) installs those at
build time and exits **0**; its image is
`sha256:4a557c8103a576614be52724799f3e1dd697ca9794decd88b32385d38ca1450b`.
The exact [Python freeze](task-harness-acp/evidence/prime-python-freeze.txt) is
retained. This exploratory overlay resolves Python dependencies at build time;
it is **not** a proposed production lock policy.

Prime's final startup trace has **zero AF_INET/AF_INET6 connects**. Its own
supervisor/worker connections use private Unix sockets. Tool runs add only
loopback model connects (plus local libc nscd socket lookups). Launch controls:

```text
prime-agent --mode acp --offline --no-session --provider probe --model task
PI_OFFLINE=1                         DO_NOT_TRACK=1
PRIME_AGENT_TELEMETRY=0
PRIME_AGENT_CODING_AGENT_DIR=/work/probe/home/.prime/agent
PRIME_AGENT_SESSION_DIR=/work/probe/home/.prime/agent/sessions
PRIME_AGENT_DAEMON_SOCKET=/work/probe/tmp/daemon.sock
PRIME_AGENT_KERNEL_PYTHON=/opt/probe/python/bin/python
```

The private `models.json` contains:

```json
{"providers":{"probe":{"baseUrl":"http://127.0.0.1:<relay-port>/v1","api":"openai-completions","apiKey":"probe-placeholder","models":[{"id":"task","name":"Probe","contextWindow":32768,"maxTokens":4096}]}}}
```

Private `settings.json` selects `probe`/`task` and sets
`telemetry.enabled=false`, `traces.enabled=false`. These redundant explicit
telemetry controls are recorded as used, not claimed individually necessary.
`--offline` does **not** remove the need to bake Python; leaving its runtime
unprovisioned can trigger package/bootstrap work on first tool use.

**Check 2 passes for both eligible configurations.** The model stub sees only
`/v1/models` and `/v1/chat/completions`. Completion logs show model `task`,
streaming enabled and `relayTokenAccepted:true`, proving the real relay forwarded
the fixed task token. Example Prime success route:

```text
34 17:56:33.178315 connect(... 127.0.0.1:42537 ...) = -1 EINPROGRESS
 9 17:56:33.211817 connect(... 127.0.0.1:8443 ...) = -1 EINPROGRESS
```

The first is the agent's relay request, the second the launcher's HTTPS forward
to the TLS stub. Source and logs distinguish them; neither is the owner's gateway.
The stub logs method, route, model, offered tool names and selected arguments,
not credentials or full prompts. No tool in the probe tries external networking.

### 3.2 Shell, events and terminal results

The success command writes a marker and prints `probe-tool-ok`. The stub selects
the actual offered `shell` tool for goose and `python_repl` for Prime. Prime's
cell uses its real `bash()` handle, awaits completion and raises on a nonzero
exit. No fake engine or faux-worker hook is used.

| Case | goose 1.56.0 musl | Prime Agent 0.10.1 |
|---|---|---|
| Shell success | Marker present; `tool_call` then in_progress/completed patches; `end_turn` in 493 ms | Marker present; in_progress/completed; `end_turn` in 252 ms |
| Real client success | `succeeded`, fixed final result | `succeeded`, fixed final result |
| Shell exit 7 | `tool_call_update: failed`, `rawOutput.exit_code: 7`; then final text and `end_turn` | **Incorrect `completed`**, text includes `RuntimeError: Shell exit 7`; no structured failure/output flag; then final text and `end_turn` |
| Real client after shell exit 7 + final text | `succeeded` under existing prose-recovery policy | `succeeded`; ACP already lost the Python error flag |
| Provider HTTP 400 | Error prose + **ordinary `end_turn`**, no failed tool | JSON-RPC error `-32603`, details `prime-agent turn failed: 400 PROBE_PROVIDER_FAILURE` |
| Real client on provider HTTP 400 | `failed/provider_error` (relay observes HTTP failure) | `failed/provider_error` |

The negative shell run is intentional: the model is scripted to finish after
one failed required tool. Its final prose is not proof of success. Goose gives
machine-readable tool failure; the current generic `AcpTurn` treats later final
text as recovery, so its result is not a new goose-specific defect. Prime is
worse at the wire boundary: a thrown Python error itself is called completed.
The source review traces `ipython` error classification and the bridge that
discards its error flag. No prose/traceback parser was added to work around that
ACP gap. Root-cause repair is outside this probe.

Decisive Prime failure transcript, trimmed:

```jsonl
{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call","toolCallId":"call_probe_1","kind":"execute","status":"in_progress","rawInput":{"code":"handle = bash(\"echo PROBE_SHELL_FAILURE >&2; exit 7\")\nresult = await handle\nprint(result.output)\nif result.exit_code != 0: raise RuntimeError(f'Shell exit {result.exit_code}')"}}}}
{"method":"session/update","params":{"update":{"sessionUpdate":"tool_call_update","toolCallId":"call_probe_1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"... RuntimeError: Shell exit 7 ..."}}]}}}
{"id":3,"result":{"stopReason":"end_turn"}}
```

Goose's raw provider-error reply is also not semantically unambiguous at the
ACP-only boundary. The existing relay protects this particular HTTP-error case,
so the probe does **not** claim that real-client run falsely succeeded. The
pinned release lacks a main-only ACP error-reporting fix. There is no native
fallback in this probe.

### 3.3 ACP cancellation: process tree, not just the parent shell

The final cancel command is:

```sh
echo $$ > /work/probe/probe-shell-pid
sleep 30 & child=$!
echo $child > /work/probe/probe-child-pid
touch /work/probe/probe-start-marker
wait $child
touch /work/probe/probe-cancel-marker
```

The driver sends `session/cancel` one second after observing the tool call.
Immediately **before sending**, it records the start marker and both live PIDs.
It then inspects both processes at prompt return, two seconds later, and after
32 seconds. The agent is left alive throughout. Only after observation does
cleanup terminate it; Prime's private daemon then receives native shutdown for
cleanup only. That is not a native cancellation fallback.

**Goose fails reliable cancellation.** Both shell PID 39 and sleep PID 40 were
alive with the start marker before cancel (1,298 ms after prompt start). The
prompt returned `cancelled` at 1,309 ms. The shell was gone, but the child was
still a live **sleeping process**, not a zombie:

```text
40 (sleep) S 1 26 26 ...
```

It remained in state `S`, reparented to PID 1, two seconds after the cancelled
response. It was absent after 32 seconds, consistent with natural sleep expiry;
that is not prompt-bound cancellation. No terminal tool_call_update was emitted;
only the initial tool_call with omitted status remained. The completion marker
was absent because the parent shell died, which alone would have falsely looked
like successful cancellation. An earlier parent-only check missed this; its
result is superseded by the retained process-tree run.

**Prime passes this cancellation test.** Both shell PID 86 and child PID 90 were
alive before cancel (1,165 ms). The prompt returned `cancelled` at 1,198 ms.
Both PIDs were gone at return and remained gone at two seconds and 32 seconds.
The tool emitted `tool_call_update: failed`. This is evidence for the tested
shell family, not proof for arbitrary nested agents or all possible tools.

The first draft of the goose driver ignored a tool_call with omitted status and
therefore sent no cancel. That run is **invalid**, was rerun after treating a new
status-less tool_call as pending, and is not used in retained acceptance evidence.

### 3.4 Permission round trip

Goose approve mode emits `session/request_permission` with `allow_always`,
`allow_once`, `reject_once`, and `reject_always` offered option IDs.

- Raw and real-client denial use the launcher's exact
  `{"outcome":{"outcome":"cancelled"}}`. The shell marker stays absent and the
  tool receives failed status. The ordinary final stub text still makes the
  current real client's recovery policy return succeeded; that does not mean
  it executed the denied command.
- A separate raw allow run selects the **offered** `allow_once` option. The shell
  marker is present, the tool completes and the prompt ends normally.

Prime emits no permission request. Its corresponding run executes the shell
marker directly. Source confirms no ACP request/response flow for permissions;
this is **not implemented**, not an unanswered callback or a test timeout.
ACP permits agents that never request permission, but this task's check 3
explicitly requires demonstrating that handshake. Prime does not meet it.

## 4. ACP reference and implementation scope

The [pinned-source review](task-harness-acp/source-review.md) records primary
source links and line ranges. The official ACP v1 [tool lifecycle](https://agentclientprotocol.com/protocol/v1/tool-calls)
and [cancellation contract](https://agentclientprotocol.com/protocol/v1/prompt-turn#cancellation)
are the reference, not an agent's native protocol. A cancel notification must
settle the original prompt with cancelled after aborting operations; a returned
stop reason alone is not an OS process-tree check. Tool updates are patches,
and omitted fields do not erase earlier input/status.

| Interface | goose 1.56.0 | Prime 0.10.1 | Existing OpenCode 2.1.4 |
|---|---|---|---|
| ACP implementation | SDK 2.2.0 / schema exact 1.9.1; wire v1 | Hand-written Rust types/parser; wire v1; no external schema package pin | TS SDK 1.6.0; wire v1 |
| initialize/new/prompt/cancel/update | Yes | Yes | Yes |
| session/load | Yes, advertised | No, loadSession false | Yes |
| list/delete/close | Yes | Close only | Yes |
| resume/fork | Fork handler; standard fork capability not advertised; no standard resume dispatch | Neither | Both |
| config/mode | Provider/model/mode/thinking_effort; set_mode | Model config only; no set_mode | Config and set_mode |
| Permission request | Yes | **No** | Yes |
| Client fs/terminal bridge | Capability-dependent | Not implemented | No bridge in capability parser; agent-side execution |
| MCP | Stdio and HTTP | Stdio and HTTP | Stdio and HTTP; SSE rejected |
| Same-turn standard steer | No; custom unstable goose extension exists | No; second prompt rejected while busy | No; second prompt rejected while busy |

ACP's current v1 schema source is version 1.26.0; v2 is explicitly **Draft**.
These numbers do not mean goose serves wire protocol 2. The reference allows
optional methods and extension namespaces; support must be negotiated. Goose
uses several `_goose/unstable/*` extensions, while Prime exposes extra lifecycle
metadata under `_meta`. None is silently required by the generic client here.
Both pinned products are evolving, and later main-only fixes cannot be credited
to their published binaries.

**OpenCode gaps remain visible, not excused by a comparison:**

1. Its ACP shell mapper uses completed even for nonzero exits, but retains
   `rawOutput.metadata` exit/signal/timeout. Lifemodel's current OpenCode
   configuration inspects that structured output. Goose's ordinary nonzero
   shell mapping is better; Prime's Python traceback lacks an equivalent
   structured failure flag in this release.
2. OpenCode cancellation drains for a bounded interval; child agents can outlive
   the cancelled parent turn. Its own whole-family termination cannot be assumed.
   Prime passed the tested OS shell family; arbitrary nested agents were not
   exercised for either candidate.
3. OpenCode supports ACP permissions and reports provider/auth failures as RPC
   failures; it does not have Prime's permission absence or goose's raw HTTP-error
   prose/end_turn behavior. It has no standard uninterrupted live-steer contract.

These OpenCode observations are **source review**, not a new runtime probe of
OpenCode. The current registry and `task-opencode.ts` were read, not modified.

## 5. Recommendation and proposed registry shape

**Recommend neither pinned release for stage 4 today.** This is a completed
negative probe, not a missing-binary stop. Do not select one merely to fit the
shortlist's goose/prime/both wording: the stated disproof conditions take priority.

| Required check | GNU goose 1.56.0 control | Musl goose 1.56.0 | Prime Agent 0.10.1 |
|---|---|---|---|
| 1. Release pin + no startup egress attempts | **Fail**: pinned, but unconditional catalog DNS attempt | **Pass**, published portable asset; loopback model list only | **Pass** with baked Python/runtime and offline controls |
| 2. Custom model through real relay only | Model list route observed; full tool test not continued after check-1 failure | **Pass** | **Pass** |
| 3a. Shell + streamed tool updates | Not continued | **Pass** | **Pass** |
| 3b. Cancel stops active shell family + cancelled | Not continued | **Fail**, live sleeping orphan after response and +2 s; no settled tool status | **Pass** for tested shell family |
| 3c. ACP permission request answered | Not continued | **Pass**, denial and allow_once | **Fail/not implemented** |
| 3d. Machine-readable semantic failures | Not continued | Shell exit **pass**; raw provider error **fail**; real relay protects HTTP-error run | Provider error **pass**; Python exception tool status **fail** |
| 4. Reference/version/method review | **Complete** | **Complete** | **Complete** |
| Overall | Reject this asset | **Reject this pin** | **Reject this pin** |

**Three-line recommendation:**

1. Keep OpenCode as stage 4's current first ACP configuration; add no unproved second entry.
2. Reprobe a published main-derived goose portable release that contains the process-tree and ACP-error fixes; it already has the needed permission flow.
3. Reprobe Prime only after its ACP permission gap and Python-tool error flag are resolved; do not parse prose or use its native API as a workaround.

Goose is the closer **feature-shape** fit (ACP permission flow and structured
ordinary shell failure), not the accepted choice. Its reliable-cancel failure
is disqualifying despite the correct stop reason. Prime has stronger observed
shell-family cancellation and provider-error reporting, but lacks a required
method and loses Python exceptions at the ACP tool boundary. Neither conclusion
ranks model quality. The owner decides the next candidate/reprobe before stage
4 tasks or ADR-014 are amended.

### Registry sketch only — not approved for installation

This is the shape an entry would have **after a new pin passes**, using the
current registry's field names. The known-bad tested pins are shown to make
provisioning concrete, not as production recommendations. Only x86_64 was
verified; do not invent an arm64 checksum or mark it supported.

```json
{
  "goose": {
    "label": "goose",
    "protocol": "acp",
    "command": "/usr/local/bin/goose",
    "args": ["acp"],
    "configFile": "/etc/lifemodel/goose/config.yaml",
    "version": "1.56.0",
    "versionArgs": ["--version"],
    "versionOutput": "1.56.0",
    "adapterModule": "./task-goose.js",
    "provision": {
      "archives": {
        "x86_64": {
          "file": "goose-x86_64-unknown-linux-musl.tar.gz",
          "url": "https://github.com/aaif-goose/goose/releases/download/v1.56.0/goose-x86_64-unknown-linux-musl.tar.gz",
          "sha256": "80e7716fef3dccc3fef6850e24e5b846b7340e10e13098e53b4f47769f5803ef"
        }
      },
      "archiveMember": "./goose",
      "files": [{"source":"docker/workbench/goose/config.yaml","destination":"/etc/lifemodel/goose/config.yaml","mode":"0444"}],
      "directories": ["/etc/lifemodel/goose"]
    }
  }
}
```

`task-goose.js` here means only a `configureAgent`/semantic-output configuration
module for the generic ACP client, like the current OpenCode module, **not** a
native goose adapter. It must apply the tested knobs, point the provider at
`relayBaseURL`, and inspect structured nonzero `rawOutput.exit_code`. The current
registry uses that module hook; an accepted data-only redesign is separate work.
No such production module or config file is added by this probe.

Prime's corresponding hypothetical data would be:

```json
{
  "prime-agent": {
    "label": "Prime Agent",
    "protocol": "acp",
    "command": "/opt/prime-agent/prime-agent",
    "args": ["--mode","acp","--offline","--no-session","--provider","task","--model","task"],
    "configFile": "/etc/lifemodel/prime-agent/models.json",
    "version": "0.10.1",
    "versionArgs": ["--version"],
    "versionOutput": "0.10.1",
    "adapterModule": "./task-prime-agent.js",
    "provision": {
      "archives": {
        "x86_64": {
          "file": "prime-agent-0.10.1-linux-x64.tar.gz",
          "url": "https://github.com/PrimeIntellect-ai/prime-agent/releases/download/v0.10.1/prime-agent-0.10.1-linux-x64.tar.gz",
          "sha256": "21ec219183f4134dd23dce9572102e69456066fe374846525561c776d4d1945c"
        }
      },
      "archiveMember": "prime-agent"
    }
  }
}
```

**The Prime sketch is intentionally incomplete provisioning, not a drop-in
entry.** The present provisioner installs one executable archive member. Prime
also requires its adjacent bundled files, local runtime and baked Python
packages. A real entry needs an explicit reviewed package-extraction/ownership
plan and immutable config preparation; copying only the executable is not
sufficient. The probe's configuration module writes a private models/settings
pair with the dynamic relay URL and private socket. Whether accepted production
config is generated or immutable is a stage-4 design decision, not silently
solved by this research. Neither sketch receives a native-protocol fallback.

### What was deliberately corrected during the probe

- The inherited draft's goose update-disable variable was unsupported and removed.
- A host Nix-linked `uv` copied into the Debian overlay could not execute; that
  failed build exited 1 and was replaced with Debian's Python venv package and
  image-time pip install. No host environment/dependencies became the runtime.
- An early launcher timeout counted time waiting for the heavy-command lock and
  expired before the GNU control ran. It produced no evidence and was rerun.
  The runtime deadline now starts **inside** that lock.
- The reused Prime startup output folder held an earlier append-only transcript
  and an old inner trace. The retained transcript was cut at the final initialize
  to match its result session ID, command and outer trace; the stale trace was
  removed. The runner now refuses nonempty run folders and resets direct startup
  transcripts. The evidence verifier checks that session identity.
- The first goose cancel driver missed a valid status-less initial tool call.
  It sent no cancel and is excluded. A subsequent parent-only check was also
  insufficient: the final tree-aware run records both processes live before
  cancel and finds the orphan. Only that final run supports the cancellation
  verdict.

## 6. Limits and checks

No live model quality, owner gateway, Kubernetes Job, durable storage, arm64,
load, long-running interaction, resume, arbitrary nested agents, malicious model,
packet capture or production rollout is checked. No telemetry after the bounded
probe interval can be ruled out universally. The source controls plus observed
startup/tool traces establish only the pinned tested path. A connection syscall
trace is not a packet capture and does not observe connectionless sendto calls;
network-none still prevents external routing.

The automatic stage document gate is not installed and did not run. This is not
stage acceptance. The product suite is not run for this research-only change;
no production code is modified. The evidence verifier passed (exit 0), all five JavaScript syntax checks passed
(exit 0), and Python compilation passed (exit 0). Whitespace and the repository's
normal research-document/backlog commit hooks are checked separately. All probe
containers and probe-tagged images are removed after retaining evidence. Shared
test images/cache are not pruned. Downloaded archives and scratch runs remain
ignored under the research folder for local reproduction; no key is committed.
