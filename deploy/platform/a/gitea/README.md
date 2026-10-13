# Gitea platform component

Flux installs the vendored official Gitea chart 12.7.0 from the verified
platform OCI artifact. Explicit values disable both bundled PostgreSQL charts
and both Valkey charts. Gitea uses SQLite, its built-in LevelDB queue and its
in-memory cache. Its SQLite database and Git repositories both live below
`/data` on the chart's single retained `gitea-shared-storage` PVC.

The chart references the loader-created `gitea-admin` Secret (`username` and
`password` keys) with `passwordMode: initialOnlyNoReset`; the values explicitly
leave the chart's username and password empty. The chart renders required
`secretKeyRef`s for both keys. Until the loader creates that Secret, Kubernetes
cannot start the pod and reports `CreateContainerConfigError`; this is not a
Helm rendering error. A0 starts the loader independently, and it creates the
Secret during first-start bootstrap. Step A waits for its HelmRelease, so it
becomes ready after the Secret is created and Gitea becomes healthy.

The owner UI Ingress is `git.localhost` through Traefik. ForwardAuth is not
installed yet; the UI is not protected by it until the loader UI work adds
that integration. The NetworkPolicy admits only the loader, Flux
source-controller and Traefik to Gitea HTTP on TCP 3000, and denies all egress.
