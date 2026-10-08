# The loader

The trusted program an instance starts with. It runs as the container's main
process, owns the volume, and is the way back when lifemodel has become a
brick.

The code lives in `loader/` at the repository root - not under `src/`, which is
the instance's own code - and is built to `loader/dist/`. In the image it sits
at `/opt/lifemodel/loader/` and runs under `tini`:

```
tini -- node /opt/lifemodel/loader/dist/main.js
```

It needs no runtime dependency (node built-ins only); `typescript` and
`@types/node` are its devDependencies, so the image builds it with `npm ci &&
npm run build` inside `loader/`. This repository builds it with
`npm run build:loader` and typechecks it with `npm run typecheck:loader`; both
are part of `npm run check`.

## What it does

1. **Opens the front door.** It starts Caddy, the only web entrance, before
   anything else, and keeps it up while lifemodel is stopped, panicked or
   being built.
2. **Serves its own interface** on `127.0.0.1:7000`, always, independent of
   lifemodel.
3. **First start.** On a volume with no password it asks for one at
   `boot.<host>` (`/setup`). Once the password is set it seeds the instance's
   git repository from the code the image carries, builds it, and starts
   lifemodel.
4. **Every start after that** reuses the repository that is on the volume: a
   commit that was built is not built again, and the repository is never
   overwritten by a newer image.
5. **A failure of the instance does not stop it.** Seeding, building or
   starting lifemodel that fails leaves the loader up with Caddy, its login and
   its interface; its state says `failed` with the reason, and the owner retries
   from the page or with `lifemodel resume`. Only the inputs the loader itself
   needs to come up end the process (below).
6. **Supervises lifemodel** as an unprivileged child (uid/gid 1000), restarts
   it with a growing backoff when it dies, and refuses to start it at all
   while panic is set.
7. **Holds panic**, a root-only flag on the volume. It survives a restart of
   the container and of the Docker daemon until `lifemodel resume` clears it.
8. **Forwards SIGTERM** to lifemodel and waits up to 95 s for it to leave -
   lifemodel's own drain is 90 s, and the documented command stops the
   container at 100 s.

## The volume

One volume at `/var/lib/lifemodel`. What the loader keeps there:

| Path | Owner | What it holds |
| --- | --- | --- |
| `repo/` | lifemodel | the instance's git repository, seeded once from the seed bundle, with `upstream` as its remote |
| `data/` | lifemodel | lifemodel's `DATA_PATH`: state, logs, config, models |
| `loader/` | root, `0700` | the loader's own files, below |
| `loader/auth.json` | root, `0600` | the scrypt digest of the owner's password and the session secret |
| `loader/panic.json` | root, `0600` | present means panic is set |
| `loader/cli-token` | root, `0600` | the token `docker exec <c> lifemodel ...` proves itself with |
| `loader/state.json` | root, `0600` | which commit was built |

lifemodel runs as uid 1000 and reads none of the loader's files. The image
carries the code as `/opt/lifemodel/seed.bundle`, a `git bundle` with history;
the first start clones it, renames the bundle remote to `upstream`, points
`upstream` at `https://github.com/shady2k/lifemodel.git` and gives the
repository to lifemodel.

The loader runs as root and `repo/` belongs to uid 1000, and git refuses a
repository whose owner is not the caller:

```
fatal: detected dubious ownership in repository at '/var/lib/lifemodel/repo'
```

Every git call the loader makes on that repository therefore names that one
path as a safe directory (`git -c safe.directory=/var/lib/lifemodel/repo ...`)
- never `*`, so nothing else on the volume becomes trusted by accident. A git
call that fails is reported with git's own first line, not with the advice
under it.

## The ports and the hosts

| Address | What answers |
| --- | --- |
| `127.0.0.1:7000` | the loader's own interface, and `GET /_auth/verify` for Caddy's forward_auth |
| Caddy `:80` | the only published port; the documented command publishes it as `-p 127.0.0.1:8080:80` |
| `127.0.0.1:7100` | lifemodel's own interface, behind the root host |
| `127.0.0.1:14321` | Agent Vault's interface, behind `vault.<host>` |

Caddy routes by host: `boot.<host>` to the loader, `<host>` to lifemodel,
`vault.<host>` to Agent Vault, and asks the loader about every request
(`GET /_auth/verify`: `200 ok` with the session cookie, `401 no session`
without it). The login and password-setting routes (`/login`, `/setup`) are the
only ones a request reaches without that check. The CSS of those pages is
inline, so they need no asset route.

## The login

One cookie, `lm_session`, `HttpOnly; SameSite=Lax; Path=/`, with `Domain` set
to the host every host of the instance shares: the loader answers on
`boot.<host>`, so it strips that one label - `boot.localhost` and
`vault.localhost` are both covered by a cookie on `localhost`. The token
carries its own expiry and a signature with a secret in `loader/auth.json`, so
the loader needs no session store and a restart does not log the owner out.
A wrong password is answered with `401` and logged once at warn with the host
and the remote address - never the password.

## The command line

`/usr/local/bin/lifemodel` runs `node /opt/lifemodel/loader/dist/cli.js "$@"`
inside the container. It talks to the loader on loopback and proves itself with
the token in `loader/cli-token`, which lifemodel's user cannot read.

```
docker exec <container> lifemodel status   # running|stopped, the commit, panic on|off
docker exec <container> lifemodel panic    # stop lifemodel, hold it down
docker exec <container> lifemodel resume   # clear panic, start lifemodel
```

Each of them prints the state - `running`, `stopped`, or `failed` when the
instance did not come up - then `commit <sha>`, `panic on|off` and, while it is
failed, one more line `failed: <reason>`. A failed request exits 1 with one
line saying why. `status` and `panic` exit 0 whenever the loader answered;
`resume` exits 1 when the instance did not come up (its reason was printed).
`panic` stops lifemodel with its drain, `resume` starts it again (building this
commit first if it was never built) - and it is the retry after a failed build,
whether or not panic was ever set.

## What the loader says when it cannot go on

An input is never worked around, and what happens to the loader depends on
whose input it was.

**The loader's own inputs, checked before it serves.** It writes one JSON line
to stdout saying what is missing and why, and leaves with a non-zero code - the
container's restart policy then shows the owner a container that keeps coming
back and failing, with that line in `docker logs`:

- the volume cannot be prepared (it is not a writable directory);
- the seed bundle is missing **and the volume holds no repository yet**: the
  image carries no code to seed an instance from, and this instance has none;
- `127.0.0.1:7000` is taken;
- Caddy is missing, or has no configuration to route with.

**A failure of the instance, after the loader is up.** Seeding, building or
starting lifemodel that fails does NOT end the loader: it stays up with Caddy
and its interface, and its state says `failed` with the reason - on its page,
in the JSON of `/_api/status` and in `lifemodel status` (which prints
`failed: <reason>`). Login, panic and resume keep working: `resume` is the
retry, and a failed build waits for the owner instead of looping. The cases:
the repository is there but is not one (a file, not a directory); the git
clone, the `upstream` remote or the chown into uid 1000 failed; `npm ci` or
`npm run build` failed, or the build wrote no `dist/index.js`; the repository
has no readable commit; lifemodel could not be started. Once it has started,
lifemodel dying is the supervisor's business: it is started again with a
growing backoff (1 s, 2 s, 4 s ... up to 30 s, reset after a run of 60 s or
more), and panic holds it down.

Everything else the loader logs is one line per event, JSON with
`component=loader`, so a person reading `docker logs` can tell its lines from
lifemodel's. No secret - a password, a token - ever appears in one.

## Tests

`tests/unit/loader-*.test.ts` drive the loader through its own interfaces with
doubles only at the two boundaries a test cannot cross unprivileged: starting
lifemodel as uid 1000, and running git and npm. The volume is a real
directory, the files are really written and the HTTP server really listens.
`tests/integration/loader-*.test.ts` add the parts that need the real thing: a
real `git bundle` cloned with the real git, a real child process that traps
SIGTERM and drains before leaving under a real loader process, and - through
the loader's HTTP interface - a first start whose build fails.

`tests/integration/instance-first-start.test.ts` is the end-to-end one, with
the real loader and the real image: an empty volume, `POST /setup`, and then
what a person gets - `lifemodel status` running on a 40-hex commit, lifemodel
itself running as uid 1000. It needs docker and the first `npm ci` inside the
container, so it is off unless `LIFEMODEL_DOCKER_TESTS=1`:

```
LIFEMODEL_DOCKER_TESTS=1 npx vitest run --maxWorkers=2 tests/integration/instance-first-start.test.ts
```
