import { prepareThrottle, drawThrottle, proveThrottle } from '../../deploy/platform/logs-page-throttle-browser.mjs';
import { contrastDom } from './logs-page-contrast-dom.mjs';
import { throttleRowText } from '../../deploy/platform/logs-page-throttle.mjs';

const mode = process.argv[2];
const events = [];
const range = { from: 1794398400000, to: 1794398580000 };
const window = { namespace: 'lifemodel-motor', pod: 'real-pod', start: '2026-11-11T12:00:00Z', end: '2026-11-11T12:00:06Z', discarded: 240 };
const evidence = { task: { pod: window.pod, namespace: window.namespace }, range, window };
const url = 'https://boot-example.local/logs';
let reads = 0;
try {
  let result;
  if (mode.startsWith('prepare')) {
    let now = range.from;
    Date.now = () => now;
    globalThis.setTimeout = (done, ms) => { now += ms; done(); };
    result = await prepareThrottle(async (requested, remaining) => {
      reads++;
      events.push(['range', requested, remaining]);
      return { state: 'ok', throttle: { windows: mode === 'prepare-positive' ? [window] : [] } };
    }, async () => mode === 'prepare-missing' ? {} : evidence.task);
    result = { ...result, reads, elapsed: now - range.from };
  } else {
    const page = (name) => {
      let resolveResponse;
      const ownWindow = name === 'scan' && mode === 'prove-different' ? { ...window, discarded: 241 } : window;
      const language = mode === 'draw-ru' ? 'ru' : 'en';
      const text = throttleRowText(ownWindow, language);
      const row = {
        waitFor: async () => events.push([name, 'visible']),
        innerText: async () => mode === 'draw-wrong-text' ? text.replace('240', '239') : text,
        scrollIntoViewIfNeeded: async () => events.push([name, 'scroll']),
        boundingBox: async () => ({ y: mode === 'draw-outside' ? 950 : 100, height: 30 }),
      };
      const instance = {
        url: () => url,
        context: () => ({ storageState: async () => ({ cookies: [], origins: [] }) }),
        goto: async () => events.push([name, 'goto']),
        locator: (selector) => {
          if (selector.startsWith('section')) return { waitFor: async () => events.push([name, 'settled']) };
          if (selector.startsWith('#logs-')) return { fill: async (value) => events.push([name, selector, value]) };
          return { last: () => ({ click: async () => {
            events.push([name, 'click']);
            if (!resolveResponse) throw new Error('response waiter installed after click');
            resolveResponse();
          }, hover: async () => events.push([name, 'hover']) }) };
        },
        waitForResponse: (predicate) => {
          events.push([name, 'wait-response']);
          const response = (target) => ({ url: () => target, request: () => ({ method: () => 'GET' }),
            json: async () => ({ state: 'ok', throttle: { windows: mode === 'draw-wrong-pod' ? [{ ...ownWindow, pod: 'other' }] : mode === 'draw-later-window' ? [{ ...ownWindow, start: '2026-11-11T12:00:06Z', end: '2026-11-11T12:00:12Z' }] : [{ ...ownWindow, start: '2026-11-11T12:00:06Z', end: '2026-11-11T12:00:12Z' }, ownWindow] } }) });
          const own = `${url.replace('/logs', '/api/logs')}?from=${range.from}&to=${range.to}&offset=0`;
          for (const wrong of [own.replace('boot-example', 'other'), own.replace('/api/logs', '/api/logs/modules'), own.replace('offset=0', 'offset=1'), own.replace(`from=${range.from}`, 'from=1')]) {
            if (predicate(response(wrong))) throw new Error('accepted unrelated response');
          }
          if (!predicate(response(own))) throw new Error('rejected exact range response');
          return new Promise((resolve) => { resolveResponse = () => resolve(response(own)); });
        },
        getByRole: (role, options) => {
          events.push([name, 'region', options]);
          return { locator: () => ({ filter: ({ hasText }) => {
            if (hasText !== text) throw new Error('row did not use API identity/count');
            return { first: () => row };
          } }) };
        },
        waitForFunction: async () => events.push([name, 'enabled']),
        viewportSize: () => ({ width: 1280, height: 900 }),
        screenshot: async () => events.push([name, 'screenshot']),
        addScriptTag: async () => events.push([name, 'inject']),
        evaluate: async (fn, argument) => {
          if (typeof argument === 'string') {
            contrastDom(mode === 'prove-dark', mode === 'prove-low-contrast' && name === 'ordinary');
            return fn(argument);
          }
          return name === 'ordinary' ? {} : {
            violations: mode === 'prove-violation' ? [{ id: 'color-contrast', nodes: [{}] }] : [],
            passes: mode === 'prove-no-contrast' ? [] : [{ id: 'color-contrast' }],
            incomplete: mode === 'prove-incomplete' ? [{ id: 'color-contrast' }] : [],
          };
        },
      };
      return instance;
    };
    const ordinary = page('ordinary');
    if (mode.startsWith('draw')) result = await drawThrottle(ordinary, url, evidence, mode === 'draw-ru' ? 'ru' : 'en');
    else {
      const browser = { newContext: async () => ({
        addInitScript: async () => {}, newPage: async () => page('scan'), close: async () => events.push(['close']),
      }) };
      result = await proveThrottle(browser, ordinary, { url, evidence, language: 'en', variant: {}, axeSource: mode === 'prove-no-axe' ? null : 'axe', screenshot: 'throttle.png' });
    }
  }
  console.log(JSON.stringify({ result, events }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, events }));
}
