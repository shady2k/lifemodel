import { scanLogsAxe, observeUnavailableLogs } from '../../deploy/platform/logs-page-browser.mjs';

const mode = process.argv[2];
const events = [];
const url = 'https://boot-example.local/logs';
if (mode.startsWith('axe')) {
  const storageState = { cookies: [{ name: 'session', value: 'fixture' }], origins: [] };
  const session = { language: 'ru' };
  const scanPage = {
    goto: async (target) => events.push(['goto', target]),
    locator: () => ({ waitFor: async () => events.push(['settled']) }),
    addScriptTag: async ({ content }) => events.push(['inject', content]),
    evaluate: async () => {
      if (mode === 'axe-error') throw new Error('axe failed');
      return { violations: [{ id: 'fixture', nodes: [{}] }] };
    },
    screenshot: async (options) => events.push(['screenshot', options]),
  };
  const context = {
    addInitScript: async (fn, data) => events.push(['session', data]),
    newPage: async () => scanPage,
    close: async () => events.push(['close']),
  };
  const browser = { newContext: async (options) => {
    events.push(['context', options]);
    return context;
  } };
  const page = {
    url: () => url,
    context: () => ({ storageState: async () => storageState }),
    evaluate: async () => session,
    addScriptTag: async () => { throw new Error('ordinary page injection'); },
  };
  try {
    const result = await scanLogsAxe(browser, page, {
      locale: 'ru-RU', colorScheme: 'dark', viewport: { width: 1280, height: 900 },
    }, 'axe fixture', 'axe.png');
    console.log(JSON.stringify({ result, events }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, events }));
  }
} else {
  let waiting;
  let rendered = false;
  const reason = mode === 'store-ru' ? 'соединение отклонено' : 'the connection was refused';
  const label = mode === 'store-ru' ? 'Хранилище логов не ответило. Причина:' : 'The log store did not answer. Reason:';
  const statusText = `${label} ${reason}.`;
  const response = (target, body) => ({
    url: () => target, json: async () => body, request: () => ({ method: () => 'GET' }),
  });
  const page = {
    waitForResponse: async (predicate) => {
      events.push(['wait-response']);
      waiting = predicate;
      return new Promise((resolve) => { page.resolve = resolve; });
    },
    goto: async (target) => {
      events.push(['goto', target]);
      for (const target of [
        'https://other.local/api/logs?status=1',
        'https://boot-example.local/api/logs/modules',
        'https://boot-example.local/api/logs/settings',
        'https://boot-example.local/api/logs?from=1&to=2',
      ]) {
        if (waiting(response(target, {}))) throw new Error('wrong response matched');
      }
      const body = mode === 'store-ok' ? { state: 'ok', records: [] }
        : { state: 'unavailable', reason: 'connection_refused' };
      const own = response('https://boot-example.local/api/logs?from=1&to=2&status=1', body);
      if (!waiting(own)) throw new Error('own response not matched');
      page.resolve(own);
    },
    waitForFunction: async (fn, expected) => {
      events.push(['render-wait', expected]);
      let busy = true;
      let text = label;
      globalThis.document = {
        querySelector: () => ({ getAttribute: () => String(busy) }),
        querySelectorAll: () => [{ textContent: text }],
      };
      if (fn(expected)) throw new Error('accepted busy list or reasonless status');
      busy = false;
      if (fn(expected)) throw new Error('accepted status without reason');
      if (mode !== 'store-missing-reason') text = statusText;
      if (!fn(expected)) throw new Error('render timeout');
      rendered = true;
    },
    getByRole: (role) => {
      if (role !== 'status') throw new Error('not a status');
      return { filter: () => ({ first: () => ({ innerText: async () => {
        if (!rendered) throw new Error('read before rendered');
        return statusText;
      } }) }) };
    },
    locator: (selector) => ({
      count: async () => mode === 'store-records' ? 1 : 0,
      innerText: async () => mode === 'store-empty' ? 'No records in this range.' : '',
    }),
  };
  try {
    const result = await observeUnavailableLogs(page, url, mode === 'store-ru' ? 'ru' : 'en');
    console.log(JSON.stringify({ result, events }));
  } catch (error) {
    console.log(JSON.stringify({ error: error.message, events }));
  }
}
