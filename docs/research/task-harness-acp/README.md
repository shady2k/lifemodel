# ACP harness probe scripts

These scripts use only fixed placeholder credentials and a scripted model. They
never read the owner's model config or gateway. Run from the repository root.
No production source is changed. Binaries, scratch runs and certificates stay in
ignored `artifacts/` and `runs/`. Retained evidence is copied to `evidence/`.

## Setup

```sh
python3 docs/research/task-harness-acp/fetch-pins.py
lifemodel-heavy docker build -f docker/workbench/Dockerfile -t probe-6539/workbench:stock .
lifemodel-heavy docker build -f docs/research/task-harness-acp/Dockerfile.probe -t probe-6539/prime:0.10.1 docs/research/task-harness-acp/artifacts
openssl req -x509 -newkey rsa:2048 -nodes -keyout docs/research/task-harness-acp/artifacts/stub.key -out docs/research/task-harness-acp/artifacts/stub.crt -days 2 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1
printf 'probe-placeholder-only\n' > docs/research/task-harness-acp/artifacts/token
```

Python 3.12+ supplies the extraction filter in `fetch-pins.py`. The prime overlay
installs the release's local runtime and default Python packages at image build
time. The freeze receipt records what this probe resolved; the Dockerfile is a
research overlay, not a proposed production dependency-lock policy.

## Runs

```sh
python3 docs/research/task-harness-acp/run-local.py goose startup
python3 docs/research/task-harness-acp/run-local.py goose-musl startup
python3 docs/research/task-harness-acp/run-local.py goose-musl success
python3 docs/research/task-harness-acp/run-local.py goose-musl failure
python3 docs/research/task-harness-acp/run-local.py goose-musl provider-error
python3 docs/research/task-harness-acp/run-local.py goose-musl permission
python3 docs/research/task-harness-acp/run-local.py goose-musl cancel
python3 docs/research/task-harness-acp/run-local.py prime-agent success
python3 docs/research/task-harness-acp/run-local.py prime-agent failure
python3 docs/research/task-harness-acp/run-local.py prime-agent provider-error
python3 docs/research/task-harness-acp/run-local.py prime-agent cancel
python3 docs/research/task-harness-acp/run-local.py prime-agent success --client real
```

Every run uses the stock workbench or its Python-only overlay, `--network none`,
1 CPU, 1 GiB and 256 PIDs. A TLS stub and the **real compiled
`createTaskModelRelay`** run on loopback in the same namespace. `all-connect.log`
traces the driver, relay, stub and agent descendants. `raw-acp-driver.mjs` speaks
the same ACP v1 messages as `task-acp.ts`; `--client real` uses the unchanged
compiled `AcpTaskHarness` from the workbench. The raw client exposes stop reasons
and permission frames that the real client deliberately abstracts away.

The cancel probe writes a start marker and shell PID, runs `sleep 30`, then
writes a completion marker. It sends `session/cancel` one second after the
pending/in-progress tool event. It leaves the agent alive for 32 seconds after
the prompt returns, so killing the harness cannot hide a tool that ignored ACP
cancel. The result records PID liveness and the completion marker. Cleanup is
not evidence of successful ACP cancellation.

The stub's final text is deliberately fixed, including after a failed shell.
Judge the shell by ACP tool status/raw output and the real client's result,
not by that prose or by the driver's exit code alone. `provider-error` returns
HTTP 400 instead of a completion. The permission probe selects goose approve
mode and replies with the launcher's exact noninteractive denial.

## Verify retained results

```sh
node docs/research/task-harness-acp/verify-evidence.mjs
```

This verifies the evidence, including **expected candidate failures**. A green
verifier does not approve either candidate. Move an existing run directory aside
before rerunning; the runner refuses to mix transcripts from independent runs.

## Cleanup

Remove only named `probe-6539-*` containers and `probe-6539/*` images created by
this probe. Do not prune shared Docker resources or remove shared test images.
