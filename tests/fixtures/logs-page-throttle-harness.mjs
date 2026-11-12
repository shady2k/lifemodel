import { findDiscardedWindow, waitForThrottle, throttleRowText } from '../../deploy/platform/logs-page-throttle.mjs';
const mode = process.argv[2];
const task = { pod: 'real-pod' };
const window = { namespace: 'lifemodel-motor', pod: 'real-pod', start: '2026-11-11T12:00:00Z', end: '2026-11-11T12:00:06Z', discarded: 240 };
const answer = { state: 'ok', throttle: { state: 'unknown', windows: [window] } };
if (mode === 'unknown-row') window.discarded = null;
if (mode === 'zero') window.discarded = 0;
if (mode === 'negative') window.discarded = -1;
if (mode === 'fraction') window.discarded = 1.5;
if (mode === 'unsafe') window.discarded = Number.MAX_SAFE_INTEGER + 1;
if (mode === 'wrong-pod') window.pod = 'other';
if (mode === 'wrong-namespace') window.namespace = 'other';
if (mode === 'partial') window.end = null;
if (mode === 'unaligned') window.start = '2026-11-11T12:00:01Z';
if (mode === 'long-window') window.end = '2026-11-11T12:00:12Z';
if (mode === 'missing') answer.throttle.windows = [];
if (mode === 'unavailable') answer.state = 'unavailable';
if (mode === 'explicit-namespace') { task.namespace = 'external'; window.namespace = 'external'; }
if (mode.startsWith('text-')) {
  const [, locale, rawCount] = mode.split('-');
  window.discarded = Number(rawCount);
  console.log(JSON.stringify({ text: throttleRowText(window, locale), start: new Date(window.start).toLocaleString(locale), end: new Date(window.end).toLocaleString(locale) }));
} else if (mode.startsWith('poll-')) {
  let now = 0;
  let reads = 0;
  const pauses = [];
  const remaining = [];
  const result = await waitForThrottle(async (budget) => {
    reads++;
    remaining.push(budget);
    if (mode === 'poll-late') { now += 6; return answer; }
    if (mode === 'poll-throw') throw new Error('offline');
    if (mode === 'poll-unavailable') return { state: 'unavailable' };
    if (mode === 'poll-arrives' && reads === 3) return answer;
    return { state: 'ok', throttle: { state: 'unknown', windows: [] } };
  }, task, { boundMs: 5, pauseMs: 2, now: () => now, sleep: async (ms) => { pauses.push(ms); now += ms; } });
  console.log(JSON.stringify({ ...result, reads, pauses, ...(mode === 'poll-late' ? { remaining } : {}) }));
} else console.log(JSON.stringify({ window: findDiscardedWindow(answer, task) }));
