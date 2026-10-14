# Core image

Build the core-only image with `scripts/build-core-image.sh [tag ...]`. The
script builds only; CI publishes it separately as
`ghcr.io/shady2k/lifemodel-core:main` and `:<commit-sha>` on pushes to main.

The runtime uses Node 24 and runs as `node`. Core state lives in Postgres and
Valkey. `/tmp/lifemodel` is the runtime DATA_PATH for non-state files. The ONNX model is fetched during image build and copied into
the writable data path by the entrypoint, so embedding does not need network
access during startup. Logs are emitted to stdout and the configured log files
are under `/tmp`.

`MOTOR_CORTEX_ENABLED` is an exact `true`/`false` setting. It defaults to
`true` for existing installations; `false` disables Motor Cortex construction
and its model-facing tools, and emits one startup info line naming the setting.
The core image sets it to `false`. Set it to `true` only where Docker-backed
Motor Cortex is available. Kubernetes leaves it disabled until Motor runs as
Jobs (lifemodel-653).
