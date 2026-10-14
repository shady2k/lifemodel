# Gitea platform component

The official Gitea chart 12.7.0 and its values remain vendored in the
platform source. The pinned Helm version renders `rendered.yaml`, which step A
applies directly; `nix flake check` re-renders the chart and rejects drift.
Explicit values disable both bundled PostgreSQL charts and both Valkey charts.
Gitea uses SQLite, its built-in LevelDB queue and its in-memory cache. Its
SQLite database and Git repositories both live below `/data` on the single
retained `gitea-shared-storage` PVC.

The chart references the loader-created `gitea-admin` Secret (`username` and
`password` keys) with `passwordMode: initialOnlyNoReset`; the values explicitly
leave the chart's username and password empty. The chart renders required
`secretKeyRef`s for both keys. Until the loader creates that Secret, Kubernetes
cannot start the pod and reports `CreateContainerConfigError`; this is not a
Helm rendering error. A0 starts the loader independently, and it creates the
Secret during first-start bootstrap. Step A waits for all its resources,
so it becomes ready after the Secret is created and Gitea becomes healthy.

Gitea has no Ingress in this stage. Its NetworkPolicy allows only the loader
and Flux source-controller to reach HTTP on TCP 3000, and denies all egress.
The Gitea PVC and namespace are protected from Flux pruning; removal is an
explicit owner action.
