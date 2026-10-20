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

Compare prime-agent, the identifiable DeepSeek harness, and two or three
current open-source headless coding harnesses. Check one briefing to result;
arbitrary OpenAI-compatible endpoint from environment, without a key or config
file; HTTPS_PROXY and CA trust; shell/tools; progress and final-result protocol;
resume/stop; licence, maturity and image/package footprint.

### 2.2 Candidate comparison and primary evidence

Research in progress.

### 2.3 Local probes

Installed `prime-agent --help` exits 0. It advertises print, JSON/RPC/ACP modes,
provider/model selection, session resume, stop, tool allowlists and autonomous
bounds. Endpoint, authentication and proxy behaviour require separate evidence.

### 2.4 Recommendation, main risk, and evidence that would change it

Pending the source review and cheap local probes.

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
