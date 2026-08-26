const listeners = new Set();

export function currentPath() {
  return location.hash.replace(/^#/, '') || '/';
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (location.hash === target) {
    notify();
    return;
  }
  if (replace) history.replaceState(null, '', target);
  else location.hash = target;
}

export function onRoute(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

function notify() {
  const path = currentPath();
  for (const handler of listeners) handler(path);
}

window.addEventListener('hashchange', notify);

export function startRouter() {
  notify();
}

/** Matches `/bots/:id` style patterns against the current path. */
export function matchRoute(path, pattern) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i += 1) {
    if (patternParts[i].startsWith(':')) params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    else if (patternParts[i] !== pathParts[i]) return null;
  }
  return params;
}
