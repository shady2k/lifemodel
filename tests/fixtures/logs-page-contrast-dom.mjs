/** Minimal computed-style DOM for executing the browser contrast evaluator in Node. */
export function contrastDom(dark = false, low = false) {
  const style = (color, backgroundColor = 'transparent') => ({ color, backgroundColor, opacity: '1', backgroundImage: 'none', filter: 'none', mixBlendMode: 'normal' });
  const root = { parentElement: null, style: style(dark ? 'rgb(255, 255, 255)' : 'rgb(0, 0, 0)', dark ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)') };
  const textNode = (tag, color, background = 'transparent') => ({ tagName: tag, childNodes: [{ nodeType: 3, textContent: 'fixture' }], parentElement: root, style: style(color, background) });
  const row = textNode('P', root.style.color);
  const help = textNode('P', root.style.color, 'rgba(120, 120, 120, 0.1)');
  const button = textNode('BUTTON', low ? 'rgb(200, 200, 200)' : root.style.color);
  const region = { getAttribute: () => 'Task pod throttling', querySelectorAll: () => [row, help] };
  globalThis.getComputedStyle = (node) => node.style;
  globalThis.document = {
    querySelectorAll: (selector) => selector.startsWith('section') ? [region] : [button],
    createElement: () => ({ getContext: () => {
      let color;
      return {
        clearRect: () => {}, set fillStyle(value) { color = value; }, get fillStyle() { return color; },
        fillRect: () => {}, getImageData: () => {
          if (color === 'transparent') return { data: [0, 0, 0, 0] };
          const values = color.match(/[\d.]+/g).map(Number);
          return { data: [...values.slice(0, 3), values.length === 4 ? values[3] * 255 : 255] };
        },
      };
    } }),
  };
}
