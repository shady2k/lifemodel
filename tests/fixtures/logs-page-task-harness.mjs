import { findTaskRecord } from '../../deploy/platform/logs-page-task.mjs';
const mode = process.argv[2];
let launches = 0;
let reads = 0;
const stored = { message: 'walk-task-writer run-1 seq=1', fields: { module: 'task', pod: 'real-pod', untrusted: 'true' } };
const result = await findTaskRecord(async () => {
  reads++;
  if (mode === 'existing') return { state: 'ok', records: [{ message: 'existing', fields: stored.fields }] };
  if (reads === 1 || mode === 'missing') return { state: 'ok', records: [] };
  const fields = { ...stored.fields };
  if (mode === 'forged') fields.untrusted = 'false';
  if (mode === 'wrong-module') fields.module = 'core';
  if (mode === 'wrong-pod') fields.pod = 'unrelated';
  return { state: 'ok', records: [{ ...stored, fields }] };
}, () => {
  launches++;
  return mode === 'failed' ? null : { pod: 'real-pod', module: 'task', run_id: 'run-1' };
});
console.log(JSON.stringify(result ? { module: result.fields.module, message: result.message, launches } : { record: null }));
