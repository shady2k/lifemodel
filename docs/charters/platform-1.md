# platform-1 — Lives on a VM

**Agreed:** 2026-10-07 by the owner. **Design:** ADR-006 (`docs/adr/006-self-evolution.md`, not yet on main), stage 1.

lifemodel runs on a dedicated VM under a small loader that keeps immutable
generations, switches between them blue/green and rolls back. The owner's
controls live in the loader, outside anything the agent can change. No
self-evolution yet.

## Outcomes

Each outcome is one feature issue labelled `platform-1`. Checks run in a
development test environment (a disposable test VM is enough); where the
target VM lives is decided separately, at deployment.

1. **A new version rolls out with one ssh command without losing the
   conversation.** The new generation starts beside the running one, passes
   readiness, takes over. *Check:* in the test environment the measured
   switch gap is at most 2 s, and no Telegram update is lost or handled twice
   across the switch.
2. **A broken version rolls back by itself, and `rollback N` rolls back on
   command within a minute, data included.** *Check:* rolling out a
   generation that crash-loops ends with the loader back on the last
   known-good generation and its data checkpoint.
3. **`panic` stops everything and nothing comes back on its own**, not even
   after the VM reboots, until the owner runs `resume`. *Check:* after `panic`
   and a reboot of the test VM no lifemodel process is running.
4. **LLM spending cannot exceed the owner's limit.** Only the LLM gateway
   holds provider keys. *Check:* a generation's environment holds no provider
   key, and past the limit the gateway refuses with an explicit error.
5. **The owner's controls cannot be changed by a generation** (evolution off,
   autonomy `act`, cost limits). *Check:* a write to the loader's
   owner-controls from a generation is refused.

## Out

- The evolution loop and any self-modification (`evolution-1`).
- Motor Cortex on prime-agent; agentic tasks keep running as today until `hands-1`.
- The memory journal (`memory-1`).
- Steer, `/stop` and the durable inbox (`dialogue-1`). The one piece of dialogue
  in this milestone: a stop or cutover finishes or requeues the cognition turn
  in flight instead of losing it, because outcome 1 needs it.
- Choosing where the target VM lives.

## Carried over

Nothing: this is the first milestone.

## Finding budget

10 findings, agreed at setup; the value lives in `.backlog/config.json`
(`findingBudget`). An eleventh comes to the owner for a decision.

## Next milestone: `dialogue-1`

- A message sent during a turn is taken into account at the next iteration boundary, for every kind of turn.
- `/stop` interrupts the turn in flight.
- Messages survive restarts and cutovers, with a queue for after the turn.
