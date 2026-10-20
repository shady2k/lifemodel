# The owner's web interface — target view

Agreed with the owner on 2026-10-15 (lifemodel-vhd design). This page
describes where the interface is going. "Built so far" at the end says what
exists. The first module's decisions are ADR-011
(`docs/adr/011-web-interface.md`).

The reference the owner gave is OpenAI's "dots": one endless dialogue in
which the assistant starts tasks when they are needed, with a side panel of
activity and results. The owner's critique: the progress of the tasks is not
visible. Its conversations are full of "still running, no result yet"
messages, because the assistant has nowhere else to put progress.

## Principles

- **One conversation.** lifemodel is one companion, not a set of bots. There
  is no list of chats; topics interleave in one dialogue.
- **lifemodel is the coordinator.**
  - It answers each request at once with what it will do, then comes back
    with the result.
  - It starts tasks itself. A task never talks to the owner directly: when a
    task needs an answer, lifemodel asks in the conversation, with the
    context and its own recommendation, and passes the answer on. Several
    open questions go into one message.
- **The creature has one state.** It thinks as one, not per message. There
  are no per-message statuses, except a message that failed to send
  ("не отправлено — повторить").
- **Progress lives with the task, not in the conversation.** Tasks appear in
  the right panel, not as transcript cards or chips (owner, 2026-10-19/20;
  [ADR-014](../../adr/014-task-runtime.md)). The conversation remains ordinary
  replies, including summaries with attachments; no "still running" messages.
- **The conversation is never busy.** The owner can change the subject at
  any moment without fear that lifemodel drops what it was doing. (The
  owner, 2026-10-15: dots does some work inside its conversation turn, and
  asking about something else feels like it may abandon that work.)
  - Long work is always a task. A conversation turn is short: understand,
    answer, decide. Anything longer than one turn (running commands,
    checks, builds) becomes a task visible in the panel, never work done
    inside the turn.
  - A new message cancels nothing. A started task runs until Stop or the
    owner's explicit request.
  - Every started piece of work is visible in "Сейчас" as running, so the
    owner sees nothing was dropped without asking.
- **Several matters at once, without talking to tasks.** The owner never
  writes to a task. A message is bound to a matter in three layers:
  1. lifemodel infers it from context, and asks when unsure ("про
     синхронизацию MailFlow или про дашборд?");
  2. "↩ Ответить" on any message binds the reply to it; the
     message shows a small quote, so the history stays readable;
  3. "@" in the composer picks a task or a project.

  lifemodel's own messages about a task carry the same binding. Separate
  threads are not used: they would split the one conversation.
- **Its own first messages look like any other.** Messages lifemodel writes
  on its own are not marked.

## Layout

```
┌──────────────┬──────────────────────────────────────┬──────────────────────┐
│ lifemodel    │  ты: возьми апстрим, синхронизируй…  │ (аватар) lifemodel   │
│ ▸ Разговор   │  lifemodel: Сделаю: возьму upstream, │ думает               │
│              │  уберу ненужные патчи, заведу issue. │                      │
│              │                                      │ ИДЁТ                 │
│  MailFlow  1 │  ты ↩ «Синхр…»: issue не дублируй    │ ▶ Синхр. с upstream  │
│  Bifrost     │  lifemodel: CI зелёный, issue #611…  │   MailFlow · 12 мин  │
│  Hindsight   │  Собрать и развернуть в кластере?    │   frontend-тесты     │
│  + проект    │  [Да] [Нет] [Ответить…]              │   «проверяю дубли»   │
│              │                       Прочитано 13:21│   [журнал] [Стоп]    │
│ Память       │  •••                                 │ ЖДЁТ ОТВЕТА          │
│ Настройки    │                                      │ ЗАПЛАНИРОВАНО        │
│ Система ▾    │  [ написать…                    ➤ ]  │ РЕЗУЛЬТАТЫ ⎇ #611 …  │
└──────────────┴──────────────────────────────────────┴──────────────────────┘
```

- **Centre: the conversation.**
  - Messages with date and time separators. Links, lists and code are
    rendered.
  - Both sides speak in bubbles (the owner, 2026-10-15): lifemodel's in the
    theme's grey, with its avatar; the owner's on the right, tinted with the
    accent.
  - The owner can write at any time, without waiting for an answer.
  - "Прочитано" means lifemodel has received the message and written it into
    its history; it answers when it gets to it.
  - A "•••" bubble shows while lifemodel thinks. "Прочитано" sits under the
    owner's last message once lifemodel has taken it.
  - A question that asks for permission carries buttons: Да / Нет /
    Ответить.
  - Each message has "↩ Ответить" and reactions. lifemodel reads reactions
    as feedback.
- **The task drawer** opens from the panel:
  - the task's own feed: its steps, collapsed ("Ran commands", "Review
    finished"), its reports and a live "thinking";
  - the conversation messages bound to the task;
  - **Stop**, and "Написать про задачу", which closes the drawer and puts a
    binding to the task into the conversation's composer. The drawer has no
    composer of its own.
  - It can open full width, as a tab of its own.
- **Right: "Сейчас".**
  - lifemodel's avatar and presence: thinking, awake, asleep, or "нет связи"
    when its state is stale.
  - Running tasks, each with:
    - its project;
    - its stage;
    - the current step with numbers ("тесты 12/40");
    - how long it has run;
    - the last event in one phrase;
    - its log;
    - a **Stop** button.
  - Tasks waiting for an answer, with a link to lifemodel's question.
  - Scheduled items: reminders and deadlines.
  - Results: pull requests, reports, issues.
  - The current generation, with a way to the loader's rollback.
- **Task controls work without a cognition turn.** Soft **Stop** asks the
  harness to wrap up with no new external effects; a settings deadline
  (default five minutes) then removes its Job. **Stop now** removes it without
  waiting for uploads; only already stored and marked output is kept.
  **Stop all tasks** soft-stops every current task, not lifemodel itself.
  Owner and agent can mark a task **urgent**: it starts before ordinary queued
  work when a slot frees, with FIFO within each class and no preemption.
  The panel exposes these controls; the owner can also ask in words. Results,
  questions and changes of scope still pass through lifemodel's conversation.
  These controls are not the loader's platform panic.
- **Left: sections, not chats.**
  - **Разговор.**
  - **Проекты:** long-lived goals or areas of life, each with its tasks,
    results, memory and its slice of the conversation. lifemodel creates
    projects itself or on request; the owner can rename, merge and delete
    them. Writing from a project posts into the one conversation, tagged
    with the project.
  - **Память:** what lifemodel knows about the owner and the rules it has
    learned, by project. Each item can be corrected or deleted. When it
    remembers something, the conversation gets "запомнил: …".
  - **Настройки:** lifemodel's own settings — models, schedule, quiet hours.
  - **Система:** the loader (generations, rollback, panic), Agent Vault
    (keys) and Gitea (code), all behind the same login.
- **Phone:**
  - the same app as an installable PWA, one column, with the panel on a
    swipe;
  - Web Push for three events: lifemodel wrote on its own, a question waits,
    an unseen task finished or failed;
  - lifemodel keeps quiet hours itself.

## Out of instance-1

- Owner uploads/images remain later work (owner, 2026-10-15). Task-result
  attachments are included in motor-1 (owner, 2026-10-20): artifact IDs resolve
  through authenticated web downloads to the storage module, never S3 URLs
  ([ADR-015](../../adr/015-storage-module.md)).
- The PWA and Web Push: they need HTTPS and an address the phone reaches. A
  later feature.

## Built so far

The first module (lifemodel-vhd, ADR-011) was accepted by the owner on 2026-10-19 after a combined test on a fresh VM. The built React app is served by the web module at `/` with same-origin hashed assets and a restrictive Content-Security-Policy. The module provides owner-message intake, transcript and SSE routes, plus an internal-only operations listener for store-based readiness and Prometheus metrics. The English/Russian shell, virtualized transcript, the composer, "↩ Ответить", safe Markdown rendering and history-based "Прочитано" receipt are in place. Messages render as tinted blocks, not yet as the bubbles described above; the bubbles and the rest of the design pass wait in lifemodel-bnhq (deferred by the owner). The storage-failure, loader-outage and stuck-stream runbook is in [web-module.md](web-module.md).

The "Сейчас" panel also carries the model's own connection: the module polls the platform gateway's `/status` (bounded, once for all its clients, and its answer and period survive a reconnect) into its own stream envelope, and the panel shows "Нет связи с моделью с HH:MM — <ошибка словами>" for an outage, nothing while the model answers, and a quieter "Статус модели недоступен" when no status could be read (ADR-013 D6). The loader's settings show the same line from its own read of `/status`, and "Модель сохранена — ждём первого запроса" while the state is `unknown` after the owner saved a slot in that page session. This save fact lasts until the page closes: the safe status projection has no success timestamp, so an `ok` poll cannot prove a post-save request succeeded. The waiting line stays hidden for `ok`, `down` and unavailable status.

Login through the loader password and post-onboarding loader settings (model access, password change, CA certificate and logout) are implemented by ADR-012. Binding to tasks and "@" come with tasks.

An open page keeps itself current: when the event stream is refused,
unavailable or has ended, the page resubscribes after a short, growing delay
and reads the transcript from the last message it has, so a reply appears
without a reload (lifemodel-hf2k.1). A stream slot is leased only while its
stream renews it, so a tab or a web module that died does not keep the owner
waiting for one. When the session itself has ended, the page leaves for the
loader's login instead of showing an error, and the draft the owner was
writing comes back with it after the login.

The task panel/drawer, two Stops, stop-all, urgency and result attachments
are designed in ADR-014/015, not built yet (lifemodel-653; UI in lifemodel-hf2k).
"@", reactions, projects, memory and settings come with the features that
create tasks and projects (lifemodel-653, lifemodel-n6r).
