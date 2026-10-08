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
2. **Starts Agent Vault**, the layer that holds the keys, next and before
   lifemodel: a passwordless store on the volume, the vault lifemodel uses and
   the agent token that is lifemodel's proxy credential (below). It is kept up
   like Caddy and stopped after lifemodel.
3. **Serves its own interface** on `127.0.0.1:7000`, always, independent of
   lifemodel.
4. **First start.** On a volume with no password it asks for one at
   `boot.<host>` (`/setup`). Once the password is set it seeds the instance's
   git repository from the code the image carries, builds it, and starts
   lifemodel.
5. **Every start after that** reuses the repository that is on the volume: a
   commit that was built is not built again, and the repository is never
   overwritten by a newer image.
6. **A failure of the instance does not stop it.** Seeding, building or
   starting lifemodel that fails leaves the loader up with Caddy, its login and
   its interface; its state says `failed` with the reason, and the owner retries
   from the page or with `lifemodel resume`. Only the inputs the loader itself
   needs to come up end the process (below).
7. **Supervises lifemodel** as an unprivileged child (uid/gid 1000), restarts
   it with a growing backoff when it dies, and refuses to start it at all
   while panic is set. A lifemodel that left with the code that ASKS for a
   restart - 75, what its settings save leaves with
   (docs/features/instance/settings.md) - is started again at once instead:
   no backoff is counted, the exit and the start are logged at info, and the
   request is not held against it. A stop (panic, the container leaving) wins
   over the request, and once the loader is closing nothing is started.
8. **Holds panic**, a root-only flag on the volume. It survives a restart of
   the container and of the Docker daemon until `lifemodel resume` clears it.
9. **Forwards SIGTERM** to lifemodel and waits up to 95 s for it to leave -
   lifemodel's own drain is 90 s. The whole stop is ONE deadline of 110 s
   (`LIFEMODEL_STOP_BUDGET_MS`), counted from the moment the stop signal
   arrives: closing the loader's own server (at most 5 s), lifemodel's drain,
   Agent Vault's exit, the wait after a SIGKILL and Caddy's exit all spend it,
   and each step keeps 5 s (`LIFEMODEL_KILL_WAIT_MS`) for a killed process to be
   reaped. Agent Vault is stopped AFTER lifemodel - a drain may still be
   talking through the proxy - and before Caddy, which stays open longest so a
   person watching the page sees the stop. No step
   waits past the deadline, and some stop sooner at a cap of their own (the
   server close, a start in flight - below). When a step could not finish,
   the loader logs one error line naming each thing still pending and the
   bound it hit (`the loader is leaving with work still pending: ...`) and
   leaves with code 1 - before Docker's own kill at the documented
   `--stop-timeout 120`. A process the kernel does not release even after
   SIGKILL is left behind in that case rather than waited for.
10. **A stop meets a start safely.** A stop that arrives while lifemodel is
   being started (the panic flag being read, or the OS not yet having said the
   process runs) waits for that start and then stops what it started, and once
   the loader is leaving nothing is started at all - not a resume, not the
   restart of a death. The stop waits for such a start at most 5 s (the kill
   room, its own cap - not the stop's deadline): a panic read or a spawn
   verdict that does not come by then is given up on. The start settles at
   once - as `failed` with its reason when a process was spawned (it is
   killed, and killed again should the OS confirm it later; it is never
   owned) - so nothing waits on it, status says why, and a resume makes a
   fresh start. Should the OS confirm the start in the very moment the stop
   gives up, the start owns a running child and the stop drains it as any
   other. A panic whose stop could not finish says so: an error line naming
   what is pending, `lifemodel panic` exits 1 with that reason and the page's
   panic button answers with it (panic stays set); the page shows the
   process state as it is - `stopping` for a child that has not exited yet,
   `failed` for a start that was given up after a process was spawned,
   `stopped` when none was. A resume asked for while a panic stop is still draining waits
   for that drain and then starts lifemodel if panic is off by then, so
   `resume` never reports a start that did not happen. An exit the
   loader asked for is logged at info; one nobody asked for at warn.

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
| `loader/vault-owner.json` | root, `0600` | the instance owner account the loader registered in Agent Vault, with the password it generated (below) |
| `loader/vault-proxy.json` | root, `0600` | the vault and the agent token lifemodel's process is given as its proxy credential |
| `vault/` | root, `0700` | Agent Vault's store: its `HOME`, so its database, its CA and its CLI session are under `vault/.agent-vault/` |
| `vault-ca.pem` | root, `0644` | Agent Vault's proxy CA, written where lifemodel can READ it and not write it |

lifemodel runs as uid 1000 and reads none of the loader's files. The image
carries the code as `/opt/lifemodel/seed.bundle`, a `git bundle` with history;
the first start clones it, renames the bundle remote to `upstream`, points
`upstream` at `https://github.com/shady2k/lifemodel.git` and gives the
repository to lifemodel.

**What the loader is allowed to give away.** Only two things, and only when
this start is what made them:

- a `data/` this start created - the directory itself, given to uid 1000;
- the `repo/` clone the seed just made - that whole fresh tree, given to uid
  1000 once.

An existing `data/` or `repo/` tree is left exactly as it is. The loader never
walks a tree that was already on the volume: that traversal is what a review
found dangerous, because a uid-1000 tree can be changed between the moment it
is listed and the moment it is recursed into - a child directory swapped for a
symlink to the volume root would have given `loader/auth.json`, `cli-token` and
`panic.json` to lifemodel. The one tree that is walked is the clone this
process just made and owns, it is walked without following a link (the entries
come from the directory's own descriptor and every one is `lchown`ed), and the
walk refuses a tree that belongs to somebody else.

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

## Agent Vault

[Agent Vault](https://github.com/Infisical/agent-vault) is the layer that holds
the keys: lifemodel's requests leave through its proxy and it attaches the
credentials on the way out, so lifemodel never holds one (decisions 4 and 12).
The image pins it (0.40.0, checked against the release's `checksums.txt` at
build time) and the loader owns it as it owns Caddy: started before lifemodel,
kept up with the same growing backoff, stopped after lifemodel inside the same
one deadline.

**Its store is passwordless.** The loader runs
`agent-vault server --host 127.0.0.1 --port 14321 --mitm-port 14322
--password-stdin` and hands it one empty line: with no master password Agent
Vault sets up an unprotected store, which is what decision 4 chooses - the
protection is the directory's permissions (`vault/`, root `0700`), not a
password that would have to live somewhere. Two variables are dropped from the
child's environment on purpose: `AGENT_VAULT_MASTER_PASSWORD` (an operator's
value must not silently password-protect the store, and then disagree with
itself on the next start) and `AGENT_VAULT_ADDR` (the links Agent Vault prints
must name the address the loader gave it). Telemetry is off
(`AGENT_VAULT_TELEMETRY=false`): an instance does not report to anyone.

**What the loader makes, once.** On the first start the loader:

1. registers the instance owner account (`owner@lifemodel.local`) with a
   generated password, kept in `loader/vault-owner.json` (root, `0600`) - the
   loader's own account in Agent Vault, and nothing else holds it;
2. takes a CLI session for it: a login, and a registration on a store that has
   no account yet. The session file is what proves the account can act: a
   registration of an address that is already taken answers politely and
   creates nothing, and an account still waiting for a verification code
   cannot act for the loader at all;
3. creates the vault `lifemodel` (after asking whether it is already there);
4. creates the agent `lifemodel` in it with the vault role `proxy`, and keeps
   the token it prints in `loader/vault-proxy.json` (root, `0600`). An agent
   that is already there but whose token is not on this volume any more is
   ROTATED - the store keeps the agent, a fresh token is minted for it - so a
   lost record is recoverable instead of fatal;
5. reads the proxy's CA with `agent-vault ca fetch` and writes it whole to
   `vault-ca.pem` (root, `0644`): lifemodel's user must READ it to trust the
   proxy and must not be able to write it.

**The next start reuses all of it.** With `loader/vault-proxy.json` on the
volume, nothing is created again: the loader reads the vault and the token from
it and only re-reads the CA, so `docker restart`, a new container on the same
volume and a store that was replaced each end with exactly one vault, one agent
and one token. The store itself is made only when the volume holds none.

**What lifemodel's process is given** is that token and nothing else - the proxy
credential, in `lifemodelEnvironment()` in `loader/src/agent-vault.ts`, which is
also the ONE place lifemodel-q4x.3.2 adds the proxy variables (`HTTPS_PROXY`,
`HTTP_PROXY`, `NODE_USE_ENV_PROXY`, the CA above) and beside which the loader
installs the kernel rule that confines its egress. lifemodel's process gets no
key, no admin credential and no path into the store. The token never appears in
a log line.

**A pid file left in the store is removed before a start.** Agent Vault refuses
to start when the pid in `vault/.agent-vault/agent-vault.pid` belongs to a live
process, and a server the loader had to kill rather than wait out leaves that
file behind; in a container a later process can take that pid number. The file
is stale by construction there - the loader is the only thing that starts a
server on this volume, and it has none running at that moment - so the loader
removes it, logs one line, and starts.

## The ports and the hosts

| Address | What answers |
| --- | --- |
| `127.0.0.1:7000` | the loader's own interface, and `GET /_auth/verify` for Caddy's forward_auth |
| Caddy `:80` | the only published port; the documented command publishes it as `-p 127.0.0.1:8080:80` |
| `127.0.0.1:7100` | lifemodel's own interface, behind the root host |
| `127.0.0.1:14321` | Agent Vault's own interface and API, behind `vault.<host>` |
| `127.0.0.1:14322` | Agent Vault's proxy: lifemodel's traffic will leave through it (lifemodel-q4x.3.2) |

Caddy routes by host: `boot.<host>` to the loader, `<host>` to lifemodel,
`vault.<host>` to Agent Vault's own interface at the ROOT of that host (its UI
uses absolute `/v1` paths, so it cannot live under a subpath), and asks the
loader about every request
(`GET /_auth/verify`: `200 ok` with the session cookie). Without one, a
browser OPENING a page (`GET` or `HEAD`, from Caddy's `X-Forwarded-Method`) is
sent with `303` to `http://boot.<host>[:port]/login?next=<where it was going>`
- built from the pinned names, only the port taken from the request - and
every other request gets `401 no session`, so nothing that changes state is
ever redirected. The login page keeps `next` only when it is an `http` URL
on one of the pinned browser hosts and on the port the login was reached on
(no open redirect, and no other local service: cookies are not scoped by
port) and returns there after
the password; without a password yet, `/login` sends on to `/setup`. The login
and password-setting routes (`/login`, `/setup`) are the only ones a request
reaches without that check. The CSS of those pages is
inline, so they need no asset route.

**The hosts are pinned.** Caddy matches only `localhost`, `boot.localhost` and
`vault.localhost` (`:80` with a host matcher; anything else is answered with
one line saying so), and the loader itself answers on those three names, with
any port, plus the loopback literal `127.0.0.1` its own command line uses. Any
other `Host` is refused with `400` before a route is looked at, and no cookie
`Domain` is ever derived from a name a request supplied - so a login through a
crafted `boot.<some-other-domain>` cannot mint a cookie scoped to that domain.
A configured domain is not part of this stage; it comes with the
outside-access idea (lifemodel-sd2).

## The login

One cookie, `lm_session`, `HttpOnly; SameSite=Lax; Path=/`, with `Domain` set
to the host every host of the instance shares: the loader answers on
`boot.<host>`, so it strips that one label - `boot.localhost` and
`vault.localhost` are both covered by a cookie on `localhost`. The domain is
taken from a VETTED host only (see above). The token carries its own expiry and
a signature with a secret in `loader/auth.json`, so the loader needs no session
store and a restart does not log the owner out. A wrong password is answered
with `401` and logged once at warn with the host and the remote address - never
the password.

**Every state change is checked twice.** The session cookie is an ambient
credential: a browser sends it on a form posted from ANY page of the instance's
parent site, and lifemodel - which controls the root host - can serve such a
page. So a request that changes something must also come from a page on the
host it was sent to (`Origin`, or `Referer` when a browser sends none) AND, for
everything but `/setup` and `/login`, carry the anti-CSRF token of the loader's
own forms:

| Route | What it needs |
| --- | --- |
| `POST /setup` | `Origin`/`Referer` of the boot host. No session exists yet, so there is nothing to bind a token to |
| `POST /login` | the same, and the password |
| `POST /panic`, `POST /resume`, `POST /logout` | the session cookie, an `Origin`/`Referer` of the same host, and the `csrf` field of the form |

The token is a signature with the loader's secret over the session token
(`csrfToken` in `loader/src/auth.ts`), so it belongs to exactly one session and
only the loader can make it. It is a hidden field of every form on the page.
A refused state change is one warn line saying what was asked, from where, and
why - and nothing is changed. `POST /` is not a resume alias: the two actions
have their own addresses, and a POST there is answered `405`.

## The command line

`/usr/local/bin/lifemodel` runs `node /opt/lifemodel/loader/dist/cli.js "$@"`
inside the container. It talks to the loader on loopback and proves itself with
the token in `loader/cli-token`, which lifemodel's user cannot read.

```
docker exec <container> lifemodel status   # running|stopped|failed, the commit, panic on|off
docker exec <container> lifemodel panic    # stop lifemodel, hold it down
docker exec <container> lifemodel resume   # clear panic, start lifemodel
```

Each of them prints the state - `running`, `stopped`, or `failed` when the
instance did not come up - then `commit <sha>`, `panic on|off` and, while it is
failed, one more line `failed: <reason>`. A failed request exits 1 with one
line saying why - a panic whose stop could not finish is answered that way.
`status` exits 0 whenever the loader answered, and `panic` whenever its stop
finished;
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
- Caddy is missing, or has no configuration to route with;
- Agent Vault is missing, or its store cannot be prepared;
- Agent Vault does not answer on `127.0.0.1:14321` within 15 s
  (`LIFEMODEL_AGENT_VAULT_START_WAIT_MS`), or leaves before it answers - a
  store it cannot open exits with its own line in `docker logs`, and the
  loader's line names the store;
- the vault or the agent could not be created, or the CA could not be read:
  without them lifemodel would have no proxy credential, and a start without
  one is not a fallback.

**A failure of the instance, after the loader is up.** Seeding, building or
starting lifemodel that fails does NOT end the loader: it stays up with Caddy
and its interface, and its state says `failed` with the reason - on its page,
in the JSON of `/_api/status` and in `lifemodel status` (which prints
`failed: <reason>`). Login, panic and resume keep working: `resume` is the
retry, and a failed build waits for the owner instead of looping. The cases:
the repository is there but is not one (a file, not a directory); the git
clone, the `upstream` remote or the chown into uid 1000 failed; `npm ci` or
`npm run build` failed, or the build wrote no `dist/index.js`; the repository
has no readable commit; a start the OS refused (see below). Once it has
started, lifemodel dying is the supervisor's business: it is started again with
a growing backoff (1 s, 2 s, 4 s ... up to 30 s, reset after a run of 60 s or
more), and panic holds it down. The one exit that is not a death is the restart
code 75 lifemodel's own settings save leaves with: that one starts lifemodel
again at once, and it is logged at info - a request, not a fault.

**A start the OS refused is a failed start, not a death.** `spawn` returning is
not the process running: the OS reports a refused start as an error, and it can
arrive after the call returned. The loader waits for the child's own `spawn`
before it calls a start a success - so "the instance is ready" is only ever
logged for a start that really happened - and a refused start is recorded as
`failed` with the reason, exactly like a failed build. It is NOT retried: the
same input fails the same way every time (AGENTS.md, lesson 3), so the owner is
told instead of watching a backoff loop. `lifemodel status` prints
`failed` with that reason and `lifemodel resume` exits 1; the retry is the
owner's, after fixing what was wrong.

Everything else the loader logs is one line per event, JSON with
`component=loader`, so a person reading `docker logs` can tell its lines from
lifemodel's. No secret - a password, a token - ever appears in one.

## Tests

`tests/unit/loader-*.test.ts` drive the loader through its own interfaces with
doubles only at the two boundaries a test cannot cross unprivileged: starting
lifemodel as uid 1000, and running git and npm. The volume is a real
directory, the files are really written and the HTTP server really listens.
`tests/unit/loader-volume.test.ts` runs the loader the only way a test can as
root - chowning to its own identity, which the kernel allows - and records
every path that was given away, because what a test cannot observe (ownership)
is exactly the rule: an existing `data/` that is a symlink to the volume root
leaves the loader's files alone.
`tests/unit/loader-agent-vault.test.ts` is Agent Vault's: the start before
lifemodel with the empty password line and the store as its `HOME`, the vault
and the token created once and reused, a lost token rotated instead of a second
agent, the CA's mode, a stale pid file removed, the stop after lifemodel, and
the token in no log line. Its CLI answers and its readiness are the two
boundaries the test doubles; the store, its modes and the files are real.
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
