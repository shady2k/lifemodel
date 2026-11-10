// A task badge is judged only from records the loader actually returned.
export async function findTaskRecord(read, launch) {
  const taskRecord = (record) => record?.fields?.untrusted === 'true'
    && typeof record.fields.module === 'string' && record.fields.module === 'task';
  const existing = await read();
  if (existing?.state !== 'ok') return null;
  const held = existing.records?.find(taskRecord);
  if (held) return held;
  const task = await launch();
  if (!task) return null;
  const answer = await read(task);
  if (answer?.state !== 'ok') return null;
  return answer.records?.find((record) => taskRecord(record)
    && record.fields.module === task.module && record.fields.pod === task.pod
    && record.message?.includes(task.run_id) && /seq=1(?:\s|$)/.test(record.message)) ?? null;
}
