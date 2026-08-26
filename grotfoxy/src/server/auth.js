import { all, get, now, run } from '../db/index.js';
import config from '../config.js';
import {
  hashPassword,
  newId,
  randomToken,
  tokenDigest,
  verifyPassword,
} from '../core/crypto.js';
import { clearCookie, HttpError, setCookie, unauthorized } from './router.js';

export const SESSION_COOKIE = 'grotfoxy_session';

export function userCount() {
  return get('SELECT COUNT(*) AS n FROM users')?.n ?? 0;
}

export function needsSetup() {
  return userCount() === 0;
}

export function createUser({ username, password, displayName = '' }) {
  const clean = String(username ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{2,40}$/.test(clean)) {
    throw new HttpError(400, 'Username must be 2-40 characters: letters, numbers, dot, dash or underscore.');
  }
  if (String(password ?? '').length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters.');
  }
  if (get('SELECT id FROM users WHERE username = ?', clean)) {
    throw new HttpError(409, 'That username is already taken.');
  }
  const id = newId('usr');
  run(
    'INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    clean,
    displayName || clean,
    hashPassword(password),
    now(),
  );
  return { id, username: clean, displayName: displayName || clean };
}

export function setPassword(username, password) {
  const clean = String(username ?? '').trim().toLowerCase();
  const user = get('SELECT id FROM users WHERE username = ?', clean);
  if (!user) throw new HttpError(404, `No user named "${clean}"`);
  if (String(password ?? '').length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
  // Every existing session becomes invalid, which is the point of a reset.
  run('DELETE FROM sessions WHERE user_id = ?', user.id);
  return true;
}

export function authenticate(username, password) {
  const user = get('SELECT * FROM users WHERE username = ?', String(username ?? '').trim().toLowerCase());
  if (!user) return null;
  if (!verifyPassword(password, user.password_hash)) return null;
  return { id: user.id, username: user.username, displayName: user.display_name };
}

export function createSession(userId, userAgent = '') {
  const token = randomToken(32);
  const expires = new Date(Date.now() + config.sessionTtlDays * 86_400_000);
  run(
    'INSERT INTO sessions (id, user_id, token_digest, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId('ses'),
    userId,
    tokenDigest(token),
    String(userAgent).slice(0, 200),
    now(),
    expires.toISOString(),
  );
  return { token, expires };
}

export function destroySession(token) {
  if (token) run('DELETE FROM sessions WHERE token_digest = ?', tokenDigest(token));
}

export function userForSession(token) {
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.username, u.display_name, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_digest = ?`,
    tokenDigest(token),
  );
  if (!row) return null;
  if (Date.parse(row.expires_at) < Date.now()) {
    run('DELETE FROM sessions WHERE token_digest = ?', tokenDigest(token));
    return null;
  }
  return { id: row.id, username: row.username, displayName: row.display_name };
}

export function createApiToken(userId, name) {
  const token = `gfx_${randomToken(24)}`;
  run(
    'INSERT INTO api_tokens (id, user_id, name, token_digest, token_hint, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    newId('tok'),
    userId,
    String(name ?? 'API token').slice(0, 60),
    tokenDigest(token),
    `${token.slice(0, 8)}…${token.slice(-4)}`,
    now(),
  );
  return token;
}

export function listApiTokens(userId) {
  return all(
    'SELECT id, name, token_hint, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC',
    userId,
  ).map((row) => ({
    id: row.id,
    name: row.name,
    hint: row.token_hint,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  }));
}

export function revokeApiToken(userId, id) {
  run('DELETE FROM api_tokens WHERE id = ? AND user_id = ?', id, userId);
}

export function userForApiToken(token) {
  if (!token) return null;
  const row = get(
    `SELECT u.id, u.username, u.display_name, t.id AS token_id
       FROM api_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_digest = ?`,
    tokenDigest(token),
  );
  if (!row) return null;
  run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id);
  return { id: row.id, username: row.username, displayName: row.display_name };
}

function bearerToken(req) {
  const header = req.headers.authorization ?? '';
  return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
}

/**
 * Resolves the caller from either a browser session cookie or an `Authorization:
 * Bearer` API token, so the same endpoints serve the UI and any scripts you
 * point at the box.
 */
export function attachUser(ctx) {
  ctx.user =
    userForSession(ctx.cookies[SESSION_COOKIE]) || userForApiToken(bearerToken(ctx.req)) || null;
  return true;
}

export function requireAuth(ctx) {
  if (!ctx.user) throw unauthorized();
  return ctx.user;
}

export function beginSession(ctx, user) {
  const { token, expires } = createSession(user.id, ctx.req.headers['user-agent'] ?? '');
  setCookie(ctx.res, SESSION_COOKIE, token, {
    expires,
    secure: ctx.url.protocol === 'https:',
  });
  return user;
}

export function endSession(ctx) {
  destroySession(ctx.cookies[SESSION_COOKIE]);
  clearCookie(ctx.res, SESSION_COOKIE);
}

export function purgeExpiredSessions() {
  run('DELETE FROM sessions WHERE expires_at < ?', now());
}
