import '../test/helpers/env.js';
import assert from 'node:assert/strict';
import test, { after, before, describe } from 'node:test';

import bootstrap from '../src/bootstrap.js';
import { createServer } from '../src/server/index.js';
import { createProvider } from '../src/services/providers.js';
import { getRun } from '../src/services/runs.js';
import { startFakeModel, waitForRun } from './helpers/fake-model.js';

let server;
let origin;
let model;
let providerId;

/** Minimal cookie jar so the tests exercise the same session flow a browser does. */
const jar = new Map();

async function call(method, path, body, { auth = true, headers = {} } = {}) {
  const cookie = auth
    ? [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
    : '';
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  for (const raw of response.headers.getSetCookie?.() ?? []) {
    const [pair] = raw.split(';');
    const index = pair.indexOf('=');
    const name = pair.slice(0, index);
    const value = pair.slice(index + 1);
    if (value === '') jar.delete(name);
    else jar.set(name, value);
  }

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }
  return { status: response.status, body: payload };
}

before(async () => {
  bootstrap();
  model = await startFakeModel([{ content: 'Task complete.' }]);
  providerId = createProvider({
    name: 'Fake',
    kind: 'openai',
    baseUrl: model.baseUrl,
    apiKey: 'k',
    defaultModel: 'fake-model-1',
  }).id;

  server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await model?.close();
  server?.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

describe('health and setup', () => {
  test('health check needs no credentials', async () => {
    const { status, body } = await call('GET', '/healthz', undefined, { auth: false });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
  });

  test('a fresh instance reports that it needs an owner', async () => {
    const { body } = await call('GET', '/api/session', undefined, { auth: false });
    assert.equal(body.authenticated, false);
    assert.equal(body.needsSetup, true);
  });

  test('the API is closed before an owner exists', async () => {
    const { status } = await call('GET', '/api/bots', undefined, { auth: false });
    assert.equal(status, 401);
  });

  test('rejects a weak password during setup', async () => {
    const { status, body } = await call('POST', '/api/setup', { username: 'owner', password: 'short' });
    assert.equal(status, 400);
    assert.match(body.error, /at least 8 characters/);
  });

  test('creates the owner and signs them in', async () => {
    const { status, body } = await call('POST', '/api/setup', {
      username: 'robert',
      password: 'a-good-long-password',
      displayName: 'Robert',
    });
    assert.equal(status, 200);
    assert.equal(body.user.username, 'robert');
    assert.ok(jar.has('grotfoxy_session'), 'a session cookie should be set');

    const session = await call('GET', '/api/session');
    assert.equal(session.body.authenticated, true);
    assert.equal(session.body.needsSetup, false);
  });

  test('setup cannot be run twice', async () => {
    const { status } = await call('POST', '/api/setup', { username: 'someone', password: 'another-password' });
    assert.equal(status, 409);
  });

  test('a wrong password is refused', async () => {
    const { status } = await call('POST', '/api/login', { username: 'robert', password: 'nope' }, { auth: false });
    assert.equal(status, 401);
  });
});

describe('bots', () => {
  let botId;

  test('creates a bot', async () => {
    const { status, body } = await call('POST', '/api/bots', {
      name: 'API Tester',
      job: 'Answer immediately.',
      providerId,
      model: 'fake-model-1',
      tools: ['get_current_time'],
      approvalPolicy: 'never',
    });
    assert.equal(status, 200);
    assert.equal(body.name, 'API Tester');
    botId = body.id;
  });

  test('rejects an invalid cron expression', async () => {
    const { status, body } = await call('PATCH', `/api/bots/${botId}`, { scheduleCron: 'not a cron' });
    assert.equal(status, 400);
    assert.match(body.error, /cron/);
  });

  test('previews a valid schedule', async () => {
    const { body } = await call('POST', '/api/cron/preview', { expression: '0 7 * * *' });
    assert.equal(body.valid, true);
    assert.equal(body.upcoming.length, 3);
    assert.ok(Date.parse(body.upcoming[0]) > Date.now());
  });

  test('runs a task and returns the result', async () => {
    const { status, body } = await call('POST', `/api/bots/${botId}/run`, { task: 'Say hello.' });
    assert.equal(status, 200);
    assert.equal(body.status, 'queued');

    const finished = await waitForRun(getRun, body.id);
    assert.equal(finished.status, 'succeeded');

    const detail = await call('GET', `/api/runs/${body.id}`);
    assert.equal(detail.body.result, 'Task complete.');
    assert.ok(detail.body.steps.length > 0);
    assert.equal(detail.body.bot.name, 'API Tester');
  });

  test('refuses an empty task', async () => {
    const { status } = await call('POST', `/api/bots/${botId}/run`, { task: '   ' });
    assert.equal(status, 400);
  });

  test('a paused bot will not accept work', async () => {
    await call('PATCH', `/api/bots/${botId}`, { enabled: false });
    const { status, body } = await call('POST', `/api/bots/${botId}/run`, { task: 'Anything.' });
    assert.equal(status, 500);
    assert.match(body.error, /paused/);
    await call('PATCH', `/api/bots/${botId}`, { enabled: true });
  });

  test('reports 404 for an unknown bot', async () => {
    const { status } = await call('GET', '/api/bots/bot_does_not_exist');
    assert.equal(status, 404);
  });
});

describe('webhook triggers', () => {
  let botId;
  let hookUrl;

  before(async () => {
    const { body } = await call('POST', '/api/bots', {
      name: 'Hooked',
      providerId,
      model: 'fake-model-1',
      tools: [],
      approvalPolicy: 'never',
    });
    botId = body.id;
  });

  test('mints a trigger URL', async () => {
    const { body } = await call('POST', `/api/bots/${botId}/webhook`, { enabled: true });
    assert.equal(body.enabled, true);
    assert.ok(body.token.length > 20);
    assert.ok(body.url.includes(`/hooks/${botId}/`));
    hookUrl = new URL(body.url).pathname;
  });

  test('starts a run without a session cookie', async () => {
    const { status, body } = await call(
      'POST',
      hookUrl,
      { task: 'Triggered from outside.' },
      { auth: false },
    );
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    const finished = await waitForRun(getRun, body.runId);
    assert.equal(finished.status, 'succeeded');
    assert.equal(finished.trigger, 'webhook');
    assert.equal(finished.task, 'Triggered from outside.');
  });

  test('passes an arbitrary payload through to the bot', async () => {
    const { body } = await call(
      'POST',
      hookUrl,
      { alert: 'front door opened', at: '02:14' },
      { auth: false },
    );
    const finished = await waitForRun(getRun, body.runId);
    assert.match(finished.task, /front door opened/);
    assert.match(finished.task, /Webhook payload/);
  });

  test('rejects a wrong token', async () => {
    const { status } = await call('POST', `/hooks/${botId}/wrong-token`, {}, { auth: false });
    assert.equal(status, 404);
  });

  test('rotating the token invalidates the old one', async () => {
    const previous = hookUrl;
    await call('POST', `/api/bots/${botId}/webhook`, { enabled: true });
    const { status } = await call('POST', previous, {}, { auth: false });
    assert.equal(status, 404);
  });

  test('disabling the webhook closes the door', async () => {
    const { body } = await call('POST', `/api/bots/${botId}/webhook`, { enabled: true });
    await call('POST', `/api/bots/${botId}/webhook`, { enabled: false });
    const { status } = await call('POST', new URL(body.url).pathname, {}, { auth: false });
    assert.equal(status, 404);
  });
});

describe('lan-only guard', () => {
  test('refuses a request a tunnel forwarded from the public internet', async () => {
    const response = await fetch(`${origin}/healthz`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(response.status, 403);
    assert.match(await response.text(), /only answers callers on its own network/);
  });

  test('still serves a proxy forwarding a LAN visitor', async () => {
    const response = await fetch(`${origin}/healthz`, {
      headers: { 'x-forwarded-for': '192.168.1.44' },
    });
    assert.equal(response.status, 200);
  });

  test('the guard covers the API, not just static routes', async () => {
    const response = await fetch(`${origin}/api/session`, {
      headers: { 'x-forwarded-for': '203.0.113.7' },
    });
    assert.equal(response.status, 403);
  });

  test('webhook triggers are covered too', async () => {
    const response = await fetch(`${origin}/hooks/anything/anytoken`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 403);
  });
});

describe('behind a TLS proxy', () => {
  test('marks the session cookie Secure when the proxy says https', async () => {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ username: 'robert', password: 'a-good-long-password' }),
    });
    const cookie = (response.headers.getSetCookie?.() ?? []).find((entry) =>
      entry.startsWith('grotfoxy_session='),
    );
    assert.ok(cookie, 'a session cookie should be issued');
    assert.match(cookie, /;\s*Secure/, 'a proxied https request must yield a Secure cookie');
  });

  test('leaves it unmarked on a genuine plain-http request', async () => {
    const response = await fetch(`${origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'robert', password: 'a-good-long-password' }),
    });
    const cookie = (response.headers.getSetCookie?.() ?? []).find((entry) =>
      entry.startsWith('grotfoxy_session='),
    );
    assert.ok(cookie);
    assert.ok(!/;\s*Secure/.test(cookie), 'Secure over plain http would lock the owner out');
  });

  test('hands out webhook URLs on the scheme the browser actually used', async () => {
    const created = await call('POST', '/api/bots', {
      name: 'Proxied',
      providerId,
      model: 'fake-model-1',
      tools: [],
    });
    const response = await fetch(`${origin}/api/bots/${created.body.id}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-proto': 'https',
        cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      },
      body: JSON.stringify({ enabled: true }),
    });
    const payload = await response.json();
    assert.match(payload.url, /^https:\/\//, 'a proxied install must not advertise an http trigger URL');
  });
});

describe('api tokens', () => {
  test('authenticate the same endpoints as a session', async () => {
    const { body } = await call('POST', '/api/tokens', { name: 'Home Assistant' });
    assert.ok(body.token.startsWith('gfx_'));

    const withToken = await call('GET', '/api/bots', undefined, {
      auth: false,
      headers: { authorization: `Bearer ${body.token}` },
    });
    assert.equal(withToken.status, 200);
    assert.ok(Array.isArray(withToken.body));

    const listed = await call('GET', '/api/tokens');
    assert.equal(listed.body.length, 1);
    assert.ok(!JSON.stringify(listed.body).includes(body.token), 'the raw token must never be readable again');
  });

  test('a revoked token stops working', async () => {
    const created = await call('POST', '/api/tokens', { name: 'Temporary' });
    const tokens = await call('GET', '/api/tokens');
    const target = tokens.body.find((entry) => entry.name === 'Temporary');

    await call('DELETE', `/api/tokens/${target.id}`);
    const after = await call('GET', '/api/bots', undefined, {
      auth: false,
      headers: { authorization: `Bearer ${created.body.token}` },
    });
    assert.equal(after.status, 401);
  });
});

describe('providers', () => {
  test('never returns a stored API key', async () => {
    const { body } = await call('GET', '/api/providers');
    const serialized = JSON.stringify(body);
    assert.ok(!serialized.includes('"apiKey"'));
    assert.ok(!serialized.includes('api_key'));
    const fake = body.providers.find((entry) => entry.id === providerId);
    assert.equal(fake.hasKey, true, 'the UI still needs to know a key is set');
  });

  test('lists models from a reachable provider', async () => {
    const { body } = await call('POST', `/api/providers/${providerId}/test`);
    assert.equal(body.ok, true);
    assert.deepEqual(body.models, ['fake-model-1', 'fake-model-2']);
  });

  test('offers presets including free local options', async () => {
    const { body } = await call('GET', '/api/providers');
    const free = body.presets.filter((preset) => preset.free);
    assert.ok(free.length >= 2);
    assert.ok(free.some((preset) => preset.kind === 'ollama'));
  });
});

describe('static assets', () => {
  test('serves the app shell', async () => {
    const response = await fetch(`${origin}/`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /GrotFoxy/);
  });

  test('falls back to the shell so client routes survive a refresh', async () => {
    const response = await fetch(`${origin}/bots/bot_whatever`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<div id="app"/);
  });

  test('refuses to serve files outside the public folder', async () => {
    const response = await fetch(`${origin}/../src/config.js`, { redirect: 'manual' });
    const text = await response.text();
    assert.ok(!text.includes('masterKey'), 'must not leak source outside public/');
  });
});

describe('sessions', () => {
  test('signing out invalidates the cookie', async () => {
    await call('POST', '/api/logout');
    const { body } = await call('GET', '/api/session');
    assert.equal(body.authenticated, false);
  });

  test('signing back in works', async () => {
    const { status } = await call('POST', '/api/login', { username: 'robert', password: 'a-good-long-password' });
    assert.equal(status, 200);
    const { body } = await call('GET', '/api/session');
    assert.equal(body.authenticated, true);
  });
});
