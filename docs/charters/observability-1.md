# observability-1 — You see what every part of the platform did

**Agreed:** 2026-11-01 by the owner, one question at a time, after motor-1
closed on what it delivered and its retrospective (lifemodel-tkv2) was held.
The owner gave the whole charter his yes («Да») after a judgement by a different
model (codex, gpt-6.1-sol: accept with changes). Its findings were worked into
the checks, the Out list and the budget note.
The owner put observability right after motor-1 on 2026-10-19 (lifemodel-vbog:
«давай сделаем следующей вехой именно наблюдаемость»).

Today a failure is found by reading each pod's stdout with kubectl, and those
logs are lost when the pod restarts. A model error shows only a code. A chat
message cannot be followed through the core to the model gateway in one record.
In motor-1 the owner and the test machine also caught failures that the checks
let through: tests that fail at random, a gateway stricter than the standard,
vendor names in generic code. This milestone lets the owner see what each part
did and why it failed from the loader's interface, with no shell into the cluster. Its checks
reject those failures before a merge, so the owner no longer has to catch them.

Whom and why, by the vision: the owner steers lifemodel through conversation
and runs it as one owner on his own machine, never as a hosted service. When
the conversation breaks, O1 lets him still see why. An agent that decides on
its own when to think, act and reach out needs O2 to explain what it did. An
agent that develops itself can be changed safely only behind checks that
reject what humans caught by hand, which is O3.

## Outcomes

Each outcome is one feature issue labelled `observability-1`. Checks run on the
owner's test VM, never on a real instance; interfaces are accepted by PRA-001.

- O1: **The logs of every module are kept on the machine and searched in the
  loader** (lifemodel-vbog). Logs survive a restart. The loader's logs page sits
  behind its login and works when the core or the chat is broken. It searches by
  time, module, level and conversation. Failures carry safe reasons: field and
  type, never values. Nothing leaves the machine.
  *Check:* after a planted model failure and a restart of the failing module,
  the owner opens the logs page in real browsers, finds the failure by time and
  conversation and reads which module failed and why. The check fails if any
  step needs kubectl or a probe. Acceptance also shows that every platform module
  appears, that each of the four filters narrows the results, that the page
  refuses without the loader's login, and that it still answers with the core
  and the chat stopped.
- O2: **One chat message is followed through the whole platform by one request
  id** (lifemodel-2mou). The model-call spans and the gateway exchange capture
  already exist (PRs #159, #160, #162). What remains is to record the core's
  ticks and turns as span trees and to carry the id from the chat through the
  core to the gateway. The gateway refuses only what it needs from a model's
  response and accepts what the OpenAI-compatible standard allows.
  *Check:* from one message in the web chat, `lifemodel doctor trace` and the
  logs page show the turn's model calls, tools, a started task and the gateway
  request under one id. The check fails if any link needs a timestamp guess or
  kubectl. The captured response shapes of every configured model pass through
  the gateway, streamed and buffered. A response that breaks what the gateway
  needs is still refused, with its field and type.
- O3: **Required checks reject, before a merge, the failures that the owner and
  the test machine caught in motor-1** (lifemodel-0kcv). Repetition makes a test
  that fails at random far less likely to reach main, but it cannot guarantee it.
  CI runs a pull request's new and changed test files several
  times beside the rest of the suite. A vendor name or registry address outside
  its adapter or the default settings fails the check. A source or test file
  cannot grow past its recorded size.
  *Check:* planted pull requests fail a required check:
  - a test that fails within the chosen repetition count;
  - an `opencode` in generic task code;
  - a `ghcr.io` in loader code;
  - a new oversized file;
  - a listed file grown past its count.

  A pull request with stable tests passes, and the PR records its CI cost. A
  shrunk file lowers its recorded count. Main as it stands passes.

## Out

- The loader watching the cluster with notifications (lifemodel-7514), the
  machine and cluster metrics (lifemodel-sw1s) and the small supervisor
  outside the cluster (lifemodel-ahrm). They go to `observability-2`, which
  comes after `motor-2` (owner, 2026-11-01).
- Anything that sends logs, traces or metrics off the machine.
- Repairing existing tests that fail at random: each one stays its own finding.
- Splitting today's large files: the size limit only stops them from growing.
- Diagnosis while k3s itself is down. That needs the supervisor outside the
  cluster (`observability-2`).
- Changing what the core does with a model's response. O2 changes only what
  the gateway accepts.
- Bounded log retention, disk use, module coverage and the cost of repeated
  tests are settled in each feature's design, not here.

## Carried over

Nothing open is carried over from motor-1. Its open work went to `motor-2`
(`docs/charters/motor-1.md`, Closed). The motor-1 retrospective filed
lifemodel-hbsi, lifemodel-p5mc and lifemodel-1be4 for this milestone. Since
2026-10-19 lifemodel-5zoc (the file-size limit) has waited here.

## Finding budget

8 findings (owner, 2026-11-01), the value with which motor-1 started. motor-1
ended at 11 of 11, and collecting every module's logs brings storage and
integration work, so a raise is likely to come back as a decision. The
retrospective's tasks and the file-size limit are planned work, not findings. The value
lives in `.backlog/config.json` (`findingBudget`). A ninth finding comes to the
owner for a decision.

No target date: none was set from outside the work.

## Next milestones

The owner set this order on 2026-11-01:

- `instructions-1` — The agent's instructions agree with each other
  (lifemodel-7iej).
- `registry-1` — Your own image registry is a mirror (lifemodel-w3fb).
- `motor-2` — Tasks within the owner's bounds, shown beside the conversation
  (lifemodel-653, -ey3e, -hf2k, -97bj).
- `observability-2` — The loader and the machine watch the platform's health
  (lifemodel-7514, -sw1s, -ahrm).
- Then `generations-1`.
