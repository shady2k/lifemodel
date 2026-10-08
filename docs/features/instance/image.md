# The instance image

One container runs a whole instance: the loader, Caddy as its only web
entrance, Agent Vault as the layer that holds the keys, and lifemodel as an
unprivileged user whose code is a git repository on a volume. A person starts it with one `docker run` (README, "Run your own
instance").

## What the image carries

| Path | What it is |
| --- | --- |
| `/opt/lifemodel/loader/` | the loader, built from `loader/` (its `dist/main.js` is the ENTRYPOINT's process, its `dist/cli.js` is the `lifemodel` command) |
| `/usr/bin/caddy` | Caddy 2.11.7, copied from the pinned official image |
| `/usr/local/bin/agent-vault` | Agent Vault 0.40.0, the credential proxy (decision 4 and 12): downloaded from its release at build time and checked against the release's `checksums.txt` before it is unpacked |
| `/etc/lifemodel/Caddyfile` | the front door's routing, root-owned |
| `/usr/local/bin/lifemodel` | `node /opt/lifemodel/loader/dist/cli.js "$@"` — `status`, `panic`, `resume` |
| `/opt/lifemodel/seed.bundle` | a `git bundle` of the repository with its history at the commit the image was built from |

It does **not** carry lifemodel's sources: the instance's code is the
repository the loader makes on the volume from that bundle, so a newer image
never overwrites it. The runtime is node 24 on `node:24-bookworm-slim` with
`tini`, `git`, `ca-certificates`, `iptables`, `netbase` and `curl`; the native
dependencies (onnxruntime, LanceDB, sharp) need nothing beyond the libraries
that base image already has.

`ENTRYPOINT` is `["/usr/bin/tini","--","node","/opt/lifemodel/loader/dist/main.js"]`
with no `USER`: the loader is root, lifemodel is uid/gid 1000 (`lifemodel`).
`DATA_PATH` is the loader's to set for lifemodel, not the image's.

## The front door

Caddy listens on `:80` inside the container; the documented `docker run`
publishes it as `127.0.0.1:8080` (the container's loopback is not reachable
through a published port, so "localhost only" is the `-p` flag). The loader
starts Caddy (`/usr/bin/caddy run --config /etc/lifemodel/Caddyfile --adapter
caddyfile`) and keeps it up while lifemodel is stopped. It starts Agent Vault
the same way (`agent-vault server --host 127.0.0.1 --port 14321 --mitm-port
14322 --password-stdin`) and keeps it up too; both are stopped only when the
container itself stops, Agent Vault after lifemodel and Caddy last.

| Host | Backend |
| --- | --- |
| `boot.<host>` | the loader, `127.0.0.1:7000` |
| `<host>` (the root host) | lifemodel's own interface, `127.0.0.1:7100` |
| `vault.<host>` | Agent Vault's own interface, `127.0.0.1:14321` (its proxy is on `127.0.0.1:14322`; neither port is published) |

**The hosts are pinned, and only these three are routed.** The Caddyfile matches
`localhost`, `boot.localhost` and `vault.localhost` and nothing else; any other
`Host` is answered with one plain line and reaches no backend and no
forward_auth. The loader likewise refuses every other name with `400` as its own second
line of defence, because it also listens where lifemodel can reach it, and it
never derives a cookie `Domain` from a name a request supplied. A configured
domain is not part of this stage: it comes with the outside-access idea
(lifemodel-sd2).

Every request on every host goes through `forward_auth` to the loader's
`GET /_auth/verify` (2xx with the session cookie; without it a browser opening
a page is redirected to the loader's login and anything else gets 401; the auth
request carries the original `Host` plus `X-Forwarded-Host`, `-Method` and
`-Uri`). The only paths that reach a backend without the cookie are the
loader's own pages on `boot.<host>`: `/login`, `/login/*`, `/setup`,
`/setup/*`, `/assets/*`, `/favicon.ico`. A host whose backend is not up yet
answers 502 with one plain line instead of an empty error page. Caddy's access
log goes to the container's stdout with the `Cookie` and `Authorization`
headers dropped, so no secret reaches `docker logs`.

## Building it

`scripts/build-image.sh` is the one command: it makes the seed bundle from the
checkout (`git bundle create`, which is why a shallow checkout is refused by
name) and runs `docker build -f docker/instance/Dockerfile`. The tags are its
arguments (`local` by default) and the image name is `LIFEMODEL_IMAGE`
(`ghcr.io/shady2k/lifemodel`). `.dockerignore` lets exactly three things into
the build context: `loader/`, `docker/instance/` and the bundle.

The build context is the run's own: a `.docker-context` that is already there
was not made by this script, so the script refuses it by name and deletes
nothing. Before that rule a stale - or a person's own - context was removed by a
build.

**Two CI jobs, and only one of them may write.** `ci-image` runs on a pull
request that owes the product checks: it builds the image with that same script
and then walks a REAL first start inside THAT image (the test below, given the
built tag as `LIFEMODEL_TEST_IMAGE`, so no second image is built), with the
workflow's own `contents: read`, a checkout that keeps no credential, and no
login anywhere - so nothing a pull request runs holds a write token.
`ci-image-publish` runs on a push to `main` and is the only job with
`packages: write`: it builds and publishes `ghcr.io/shady2k/lifemodel:main` and
`:<sha>`. It has no classifier gate, so EVERY push to main publishes - a
documents-only push included, which is what story S9 asks for.

## Testing it

`tests/integration/instance-image.test.ts` builds the image and runs a
container, then checks the front door with `Host` headers the way a browser
reaches it. It needs docker and about 600 MB, so it is off unless
`LIFEMODEL_DOCKER_TESTS=1` is set:

```
LIFEMODEL_DOCKER_TESTS=1 npx vitest run --maxWorkers=2 tests/integration/instance-image.test.ts
```

It builds from a throwaway clone with `tests/fixtures/stub-loader/` in place of
the real loader, so the image can be checked on its own; the stub is never part
of an image anyone runs. `tests/unit/build-image.test.ts` covers the script's
three refusals — a shallow checkout, a missing `loader/`, a `.docker-context`
that is already there — without docker.

`tests/integration/instance-first-start.test.ts` is the same gated walk with the
REAL loader: an empty volume, `POST /setup` on `boot.localhost`, the loader's
own line that lifemodel is running, `lifemodel status` on a 40-hex commit, and
the lifemodel process running as uid 1000. It walks Agent Vault too: the store
is root `0700` and the CA lifemodel must read is root `0644`, both listeners
answer inside the container, `vault.localhost` shows Agent Vault's own
interface behind the loader's login (and is redirected to that login without
it), and a `docker restart` reuses the same store and the same token. Run locally it builds its own image
from the checkout; with `LIFEMODEL_TEST_IMAGE=<image:tag>` it boots that image
instead and neither builds nor removes it. It is what CI's `ci-image` job runs
(`LIFEMODEL_DOCKER_TESTS=1`, on the image the job built), because a loader that builds but cannot complete a
first start used to pass that job: the image check has to prove boot, not just
the build. Locally it takes about four minutes from a warm layer cache.
