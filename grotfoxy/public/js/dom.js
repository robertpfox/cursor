/** Tiny hyperscript. `h('div.card', { onclick }, ...children)` */
export function h(spec, props = null, ...children) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }

  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key in node && key !== 'list' && typeof value !== 'object') {
      node[key] = value;
    } else {
      node.setAttribute(key, value === true ? '' : value);
    }
  }

  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(node) {
  while (node.firstChild) node.firstChild.remove();
  return node;
}

export function mount(node, ...children) {
  clear(node);
  append(node, children);
  return node;
}

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Inline SVG from a path spec, so the UI needs no icon font or sprite fetch. */
export function icon(name) {
  const paths = ICONS[name] ?? ICONS.dot;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = paths;
  return svg;
}

const ICONS = {
  dot: '<circle cx="12" cy="12" r="3" />',
  home: '<path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" />',
  bots: '<rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4" /><circle cx="9" cy="14" r="1" /><circle cx="15" cy="14" r="1" />',
  check: '<path d="M4 12.5 9 17.5 20 6.5" />',
  x: '<path d="M6 6l12 12M18 6L6 18" />',
  clock: '<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z" />',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" />',
  gear: '<circle cx="12" cy="12" r="3.2" /><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />',
  play: '<path d="M7 4.5v15l13-7.5z" />',
  plus: '<path d="M12 5v14M5 12h14" />',
  tool: '<path d="M14.7 6.3a4 4 0 0 1 5 5L21 12l-3 3-9 9-3-3 9-9 3-3z" /><path d="M9 9 4 4" />',
  brain: '<path d="M9 4a3 3 0 0 0-3 3 3 3 0 0 0-1 5.8V15a3 3 0 0 0 4 2.8V20h2V4z" /><path d="M15 4a3 3 0 0 1 3 3 3 3 0 0 1 1 5.8V15a3 3 0 0 1-4 2.8V20h-2V4z" />',
  alert: '<path d="M12 4 2.5 20h19z" /><path d="M12 10v4M12 17.5v.01" />',
  question: '<circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.6 2.6 0 1 1 3.4 2.5c-.6.2-.9.8-.9 1.4v.6" /><path d="M12 17.5v.01" />',
  flag: '<path d="M5 21V4h9l-1 3h7l-2 4 2 4h-9l1-3H5" />',
  bell: '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />',
  plug: '<path d="M9 3v6M15 3v6" /><path d="M6 9h12v3a6 6 0 0 1-12 0z" /><path d="M12 18v3" />',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />',
  send: '<path d="M4 12 20 4l-8 16-2-6z" />',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />',
  pause: '<path d="M9 5v14M15 5v14" />',
  refresh: '<path d="M20 11a8 8 0 1 0-1.5 5.5" /><path d="M20 5v6h-6" />',
  back: '<path d="M15 5l-7 7 7 7" />',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" />',
};

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function relTime(iso) {
  if (!iso) return '';
  const delta = Date.now() - Date.parse(iso);
  if (!Number.isFinite(delta)) return '';
  const abs = Math.abs(delta);
  const suffix = delta >= 0 ? 'ago' : 'from now';
  if (abs < 45_000) return 'just now';
  if (abs < 3_600_000) return `${Math.round(abs / 60_000)} min ${suffix}`;
  if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)} hr ${suffix}`;
  if (abs < 604_800_000) return `${plural(Math.round(abs / 86_400_000), 'day')} ${suffix}`;
  return new Date(iso).toLocaleDateString();
}

export function clockTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function duration(ms) {
  if (!ms || ms < 1000) return `${Math.max(0, Math.round(ms ?? 0))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  return `${minutes}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function money(value) {
  const amount = Number(value ?? 0);
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

export function compactNumber(value) {
  const number = Number(value ?? 0);
  if (number < 1000) return String(Math.round(number));
  if (number < 1_000_000) return `${(number / 1000).toFixed(number < 10_000 ? 1 : 0)}k`;
  return `${(number / 1_000_000).toFixed(1)}M`;
}
