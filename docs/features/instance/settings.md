# lifemodel's own settings

lifemodel serves a small web interface on `127.0.0.1:7100`, which Caddy reaches
as the ROOT host (`localhost`) after the loader's login has checked the request.
It is lifemodel's own code (`src/settings/`), not the loader's: the model
endpoint, the models, the Telegram fields and everything lifemodel adds later
are its settings. The loader keeps only its own parts today: the login, the
panic switch and the first start. Generation selection and task ceilings are
NOT the loader's to set yet - they belong to later outcomes, and nothing on its
dashboard or in its config sets them now.

It has **no auth of its own by design**: every request is checked by the loader
before it is proxied here (`forward_auth` on the root host,
docs/features/instance/loader.md), the session cookie is the loader's, and a
request without one never arrives. The page holds no secret: the Telegram bot
token field carries an Agent Vault placeholder, and lifemodel never holds a
model key (Agent Vault injects it on the way out, lifemodel-q4x.3.*).

## What it serves

| Route | What it does |
| --- | --- |
| `GET /` | the form, with the values in lifemodel's config file, what is missing, and a link to the loader (the boot host, same port) for keys and panic |
| `POST /settings` | validate, write the config file, answer, and then ask for the restart |

`GET /` on a first start (no config file at all) is a normal page that says no
model endpoint is configured yet and names the endpoint fields that are missing
(the four endpoint fields; the Telegram chat id is blank, and the bot token
field starts as the placeholder `__telegram_bot_token__`).
lifemodel starts in that state, serves the page, and does NOT crash-loop: that
is the first start of every instance. A GET whose config file holds an endpoint
value the rules refuse (below) shows that field's error too, with the safe
representation of the value — never its secret part.

The port is `SETTINGS_PORT` (7100). It is not a setting of the interface: the
front door's own configuration names it (docker/instance/Caddyfile).

## The fields and their rules

| Field | Rule |
| --- | --- |
| endpoint base URL | an `http`/`https` URL when it is set, carrying no credentials (`user:password@` is refused) and no query string or fragment (`?...`, `#...` are refused) |
| the fast, smart and motor model | non-empty when the endpoint is set |
| Telegram chat id | a number when it is set |
| Telegram bot token | an Agent Vault placeholder (`__something__`) when it is set, never the token itself |

The endpoint is written as a whole or not at all: a model with no base URL is
refused by the field it is missing, and a base URL with an empty model by that
model's own field. The form with everything blank is a valid state (the
Telegram fields alone), and it means "no endpoint".

Not every refusal is the same kind:

- `400` — a field does not satisfy its rule: the page comes back with every
  bad field named beside it, the values the owner typed kept (a refused bot
  token is never echoed back; a refused endpoint URL is echoed without its
  secret part), and **nothing written**.
- `403` — the write route is reached from another origin (or with no Origin at
  all): not the front door, so not saved or written regardless of the fields.
- `503` — lifemodel is closing or restarting (the save arrives during the
  stop, or is still queued behind one when it does): not written; the owner is
  asked to save again once lifemodel is up.
- `500` — the write of the config file failed and **nothing was published**:
  the reason is in the log and lifemodel is NOT restarted onto a config that is
  not there. The write's publication point is one atomic rename, so a write
  that answered `500` never put the new file in place.

No rule is a silent fallback - a value is never dropped, corrected or taken
from another field.

## Where the settings are stored, and how they apply

The settings are lifemodel's config file, read at startup by
`src/config/config-loader.ts`:

- `<DATA_PATH>/config/agent.json` when `DATA_PATH` is set. The loader gives an
  instance `DATA_PATH=<volume>/data`, so an instance's settings are
  `/var/lib/lifemodel/data/config/agent.json` — the `data/` row of the volume
  layout in docs/features/instance/loader.md.
- `data/config/agent.json` (the working directory's) when it is not, which is
  what a checkout has.

One function resolves it (`resolveConfigDir`), and both the startup read and the
settings interface use it, so the file that is written is the file that is read
next. A first start has no `data/config/` directory at all: the loader makes
`data/`, and the first save creates the directory and the file (both as
lifemodel's own user, inside the data directory it owns). Every write's
temporary file name is unique to that write, so overlapping saves never share a
temporary inode and a failed save never publishes another save's content. Every OTHER field of the
file — the owner's identity, plugin configuration, anything a later version
adds — is kept exactly as it was: the interface writes the fields it owns and
touches nothing else.

The write goes through the SAME storage pipeline as the rest of lifemodel's
data (AGENTS.md, Lesson 4): DeferredStorage, flushed through JSONStorage rooted
at the config directory. The key `agent` is written as
`<config dir>/agent.json` with the object serialized as
`JSON.stringify(object, null, 2)` — the file's name and its JSON shape, the
contract between the loader and every start, are unchanged. The save is fsynced
before its atomic rename, so the file is one save WHOLE — either the old one or
the new one, never half of each — and nothing that can fail runs after the
rename: a write that throws has published nothing.

They apply by a **restart**, not by a live reload: the provider, the Telegram
channel and the rest are built once, at startup, from the config, so
reconfiguring the running agent underneath a turn is not what happens.

## The restart, and the code it uses

Saving writes the config, answers `200` (the page says lifemodel is
restarting), and only then stops lifemodel the way any stop does — the turn in
flight is drained, state and storage are flushed, the channels are released
(docs/architecture.md, the stop) — and leaves with **exit code 75**.

lifemodel asks the loader for nothing: it has no interface to it. The loader
supervises its child and reads that code as the request
(`loader/src/supervisor.ts`, `LIFEMODEL_RESTART_EXIT_CODE`; the same number in
`src/settings/restart.ts`):

- the start is made **at once** — no backoff, and the request is not counted as
  a failure, because nothing went wrong;
- it is logged at info (`lifemodel asked to be restarted: it is started again
  at once`), and the exit itself is logged at info too, not at warn;
- every other exit is a death and keeps the growing backoff.

The usual guards still hold: a stop (panic, the container leaving) wins over
the request, and once the loader is closing nothing is started.

A token the Telegram API refuses does not end lifemodel: the channel logs the
cause at error and the agent runs without Telegram (the placeholder is refused
until Agent Vault substitutes the real token on the way out,
lifemodel-q4x.3.*). It used to reject inside `bot.start()` and take the process
down, which turned one saved placeholder into a crash loop with the settings
page unreachable - the gated Docker walk is what found it. A lifemodel
that asked for a restart and then asks again immediately is started again
immediately: the code is a request, and only lifemodel's own settings save
makes it.

75 is `EX_TEMPFAIL` — "this did not work now, try again" — and it is the
contract between the two programs, so a change to it changes both.

## Tests

- `tests/unit/settings-interface.test.ts` drives the interface over HTTP: the
  form's current values, a save that writes the config and asks for the
  restart, the refusals (no base URL, an empty model, a bad URL, a chat id that
  is not a number, a token that is not a placeholder) with their field named,
  and a write that fails (no restart, nothing applied). The config file is a
  real file in a temporary directory; the restart is the one double.
- `tests/unit/llm/model-endpoint.test.ts` covers what lifemodel builds from
  that config, through `createLLMProvider`.
- `tests/integration/instance-first-start.test.ts` (gated,
  `LIFEMODEL_DOCKER_TESTS=1`) walks the real thing: login, the root host shows
  the form, a save writes `/var/lib/lifemodel/data/config/agent.json`, the
  loader logs the requested restart (and no backoff), and the running lifemodel
  serves the new values.
