import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import log from '../core/logger.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function badRequest(message, details) {
  return new HttpError(400, message, details);
}
export function unauthorized(message = 'Sign in required') {
  return new HttpError(401, message);
}
export function notFound(message = 'Not found') {
  return new HttpError(404, message);
}

/** Turns `/api/bots/:id/runs` into a matcher that also captures `id`. */
function compile(pattern) {
  const names = [];
  const source = pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        names.push(segment.slice(1));
        return '([^/]+)';
      }
      if (segment === '*') {
        names.push('wildcard');
        return '(.*)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}/?$`), names };
}

export class Router {
  constructor() {
    this.routes = [];
    this.middleware = [];
  }

  use(fn) {
    this.middleware.push(fn);
    return this;
  }

  add(method, pattern, handler, options = {}) {
    this.routes.push({ method, ...compile(pattern), handler, options, pattern });
    return this;
  }

  get(pattern, handler, options) {
    return this.add('GET', pattern, handler, options);
  }
  post(pattern, handler, options) {
    return this.add('POST', pattern, handler, options);
  }
  patch(pattern, handler, options) {
    return this.add('PATCH', pattern, handler, options);
  }
  put(pattern, handler, options) {
    return this.add('PUT', pattern, handler, options);
  }
  delete(pattern, handler, options) {
    return this.add('DELETE', pattern, handler, options);
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const route of this.routes) {
      const match = route.regex.exec(pathname);
      if (!match) continue;
      pathMatched = true;
      if (route.method !== method) continue;
      const params = {};
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]);
      });
      return { route, params };
    }
    return pathMatched ? { methodMismatch: true } : null;
  }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const ctx = {
      req,
      res,
      url,
      method: req.method,
      params: {},
      query: Object.fromEntries(url.searchParams),
      cookies: parseCookies(req.headers.cookie),
      body: undefined,
      user: null,
      state: {},
    };

    try {
      const matched = this.match(req.method, url.pathname);
      if (!matched) return { handled: false, ctx };
      if (matched.methodMismatch) throw new HttpError(405, 'Method not allowed');

      ctx.params = matched.params;
      ctx.route = matched.route;

      if (!['GET', 'HEAD', 'DELETE'].includes(req.method)) {
        ctx.body = await readJsonBody(req);
      }
      for (const fn of this.middleware) {
        const outcome = await fn(ctx);
        if (outcome === false || res.writableEnded) return { handled: true, ctx };
      }
      const result = await matched.route.handler(ctx);
      // Streaming handlers (SSE) own the response once they write headers.
      if (res.writableEnded || res.headersSent) return { handled: true, ctx };
      if (result === undefined) sendJson(res, 204, null);
      else sendJson(res, 200, result);
      return { handled: true, ctx };
    } catch (error) {
      if (res.writableEnded) return { handled: true, ctx };
      const status = error.status ?? 500;
      if (status >= 500) log.error(`${req.method} ${url.pathname} -> ${status}: ${error.stack ?? error.message}`);
      else log.debug(`${req.method} ${url.pathname} -> ${status}: ${error.message}`);
      sendJson(res, status, {
        error: error.message || 'Server error',
        ...(error.details ? { details: error.details } : {}),
      });
      return { handled: true, ctx };
    }
  }
}

export function sendJson(res, status, payload) {
  const body = payload === null ? '' : JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

const MAX_BODY_BYTES = 8 * 1024 * 1024;

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }
}

/**
 * The scheme the browser actually used. GrotFoxy behind a TLS terminator —
 * Caddy, nginx, a Cloudflare tunnel — only ever sees plain http on the socket,
 * so without this the session cookie never gets marked Secure and generated
 * links come out as http.
 *
 * Trusting the header unverified is safe for these two uses: forging it can
 * only affect the forger's own request, and the worst outcome is a cookie their
 * own browser then declines to send back.
 */
export function requestProtocol(req) {
  const forwarded = String(req.headers['x-forwarded-proto'] ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (forwarded === 'https' || forwarded === 'http') return forwarded;
  return req.socket?.encrypted ? 'https' : 'http';
}

export function requestOrigin(req) {
  return `${requestProtocol(req)}://${req.headers.host ?? 'localhost'}`;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

export function setCookie(res, name, value, options = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge) bits.push(`Max-Age=${options.maxAge}`);
  if (options.expires) bits.push(`Expires=${options.expires.toUTCString()}`);
  if (options.secure) bits.push('Secure');
  const existing = res.getHeader('set-cookie');
  const list = existing ? (Array.isArray(existing) ? existing : [existing]) : [];
  res.setHeader('set-cookie', [...list, bits.join('; ')]);
}

export function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

/**
 * Static file serving for the single-page app. Unknown paths fall back to
 * `index.html` so client-side routes survive a refresh or a bookmark.
 */
export async function serveStatic(req, res, rootDir) {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  let relative = decodeURIComponent(url.pathname);
  if (relative.endsWith('/')) relative += 'index.html';

  const root = path.resolve(rootDir);
  let file = path.resolve(root, `.${relative}`);
  if (file !== root && !file.startsWith(root + path.sep)) {
    sendText(res, 403, 'Forbidden');
    return;
  }

  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(root, 'index.html');
    if (!fs.existsSync(file)) {
      sendText(res, 404, 'Not found');
      return;
    }
  }

  const stat = fs.statSync(file);
  const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { etag });
    res.end();
    return;
  }

  const isHtml = file.endsWith('.html');
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'content-length': stat.size,
    etag,
    'cache-control': isHtml ? 'no-cache' : 'public, max-age=300',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  await pipeline(fs.createReadStream(file), res);
}
