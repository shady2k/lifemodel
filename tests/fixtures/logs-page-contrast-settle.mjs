import { measureLogsContrast } from '../../deploy/platform/logs-page-browser.mjs';
import { contrastDom } from './logs-page-contrast-dom.mjs';
const mode = process.argv[2];
const events = [];
let step = 0;
let hovered = false;
contrastDom();
const query = document.querySelectorAll;
const button = query('form button')[0];
button.disabled = true;
button.style.opacity = '0.5';
button.getAnimations = () => step === 2 ? [{ playState: 'running' }] : [];
document.querySelector = () => ({ getAttribute: () => step === 0 ? 'true' : 'false' });
const page = {
  waitForFunction: async (fn, argument) => {
    for (let tries = 0; tries < 6; tries++) {
      if (mode !== 'disabled') {
        button.disabled = step < 2;
        button.style.opacity = step < 3 ? '0.75' : '1';
      }
      if (mode === 'enabled-opacity' && step >= 3) button.style.opacity = '0.8';
      if (mode === 'enabled-filter' && step >= 3) button.style.filter = 'brightness(0.9)';
      const ready = fn(argument);
      events.push({ step, ready, disabled: button.disabled, opacity: button.style.opacity });
      if (ready) return;
      step++;
    }
    throw Object.assign(new Error('settle timeout'), { name: 'TimeoutError' });
  },
  locator: () => ({ last: () => ({
    isEnabled: async () => !button.disabled,
    hover: async () => { hovered = true; events.push({ hover: true }); },
  }) }),
  evaluate: async (fn, value) => fn(value),
};
try {
  const samples = await measureLogsContrast(page, 'Task pod throttling', { hover: true });
  console.log(JSON.stringify({ samples, events, hovered }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message, events, hovered }));
}
