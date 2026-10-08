# stub-loader

A stand-in for the loader (lifemodel-q4x.2.1), used by
`tests/integration/instance-image.test.ts` to check the instance image and its
front door **on their own**: the real loader is another task's work, and the
image's Dockerfile builds whatever `loader/` holds.

It answers exactly what the image contract needs and nothing more: the loader's
interface on 127.0.0.1:7000 with `GET /_auth/verify` (204 with the session
cookie, 401 without it), `/login` and `/setup` as its own pages, a plain
lifemodel interface on 127.0.0.1:7100 for the root host to reach, nothing at all
on 127.0.0.1:14321 (Agent Vault, stage 2) so the vault host shows the front
door's "nothing there yet", and one `component=loader` line per event on
stdout, which is what the test waits on.

It is never built into a released image: `scripts/build-image.sh` always builds
`loader/` from the repository.
