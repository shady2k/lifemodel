/** Shared read projection. ACK means native queue admission, not obedience.
 * `ended` must name a fenced terminal boundary, not a wall-clock guess. */
export function taskCommandDeliverySql(ended: string, receipt?: string): string {
  const latest =
    receipt ??
    `(SELECT r.disposition FROM core.task_command_receipts r
    WHERE r.task_id=c.task_id AND r.command_id=c.command_id
    ORDER BY r.received_at DESC,r.receipt_id DESC LIMIT 1)`;
  return `CASE
    WHEN ${latest}='inserted' THEN 'inserted'
    WHEN ${latest}='uncertain' THEN 'uncertain'
    WHEN ${latest}='failed' OR a.disposition='rejected' THEN 'not_delivered'
    WHEN ${latest}='deferred-to-next-turn' THEN 'delivered'
    WHEN a.disposition='uncertain' THEN 'uncertain'
    WHEN a.disposition='accepted' THEN 'delivered'
    WHEN ${taskLauncherTerminalSql} THEN 'not_delivered'
    WHEN ${ended} THEN 'uncertain'
    ELSE 'queued' END`;
}
export const taskLauncherTerminalSql = `EXISTS (
  SELECT 1 FROM core.task_mailbox m WHERE m.task_id=c.task_id
    AND m.attempt_id=c.attempt_id AND m.direction='task_to_core' AND m.kind='terminal')`;
export const taskAttemptEndedSql = `(
  t.state IN ('done','failed','stopped') OR t.terminal_candidate IS NOT NULL OR EXISTS (
    SELECT 1 FROM core.task_mailbox m WHERE m.task_id=c.task_id AND m.attempt_id=c.attempt_id AND m.kind='terminal'))`;
