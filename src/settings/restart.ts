/**
 * The restart request (lifemodel-q4x.4.1).
 *
 * When lifemodel saved its settings it has to be started again: the provider,
 * the Telegram channel and the rest are built once, at startup, from the
 * config. lifemodel does not reach into the loader to ask for that - it has no
 * interface to the loader at all - it simply LEAVES with this code, and the
 * loader restarts it AT ONCE instead of counting a death and waiting out a
 * backoff (loader/src/supervisor.ts, `restartRequested`).
 *
 * The number is the contract between the two programs: it is the same in
 * `LIFEMODEL_RESTART_EXIT_CODE` there, and docs/features/instance/settings.md
 * names it. 75 is EX_TEMPFAIL - "this did not work now, try again" - which is
 * exactly what the request means.
 */
export const RESTART_EXIT_CODE = 75;
