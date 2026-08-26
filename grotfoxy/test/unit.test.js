import '../test/helpers/env.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import { decryptSecret, encryptSecret, hashPassword, tokenDigest, verifyPassword } from '../src/core/crypto.js';
import { isValidCron, nextCronDate, parseCron } from '../src/util/cron.js';
import { resolveInWorkspace } from '../src/tools/files.js';
import { checkCommandAllowed } from '../src/tools/shell.js';
import { htmlToText } from '../src/tools/web.js';
import { estimateCost } from '../src/llm/pricing.js';
import { safeParseArguments } from '../src/llm/openai.js';
import { anthropicAdapter } from '../src/llm/anthropic.js';
import { parseRpcBody } from '../src/mcp/client.js';
import { mcpToolName } from '../src/tools/index.js';

describe('secrets', () => {
  test('round-trips an encrypted value', () => {
    const secret = 'sk-proj-abc123-super-secret';
    const sealed = encryptSecret(secret);
    assert.notEqual(sealed, secret);
    assert.match(sealed, /^v1:/);
    assert.equal(decryptSecret(sealed), secret);
  });

  test('returns empty string for tampered or missing payloads', () => {
    assert.equal(decryptSecret(''), '');
    assert.equal(decryptSecret('garbage'), '');
    const sealed = encryptSecret('hello');
    const tampered = `${sealed.slice(0, -4)}AAAA`;
    assert.equal(decryptSecret(tampered), '');
  });

  test('verifies passwords and rejects wrong ones', () => {
    const stored = hashPassword('correct horse battery');
    assert.equal(verifyPassword('correct horse battery', stored), true);
    assert.equal(verifyPassword('wrong horse battery', stored), false);
    assert.equal(verifyPassword('correct horse battery', 'not-a-hash'), false);
  });

  test('token digests are stable and do not contain the token', () => {
    const digest = tokenDigest('gfx_example');
    assert.equal(digest, tokenDigest('gfx_example'));
    assert.ok(!digest.includes('gfx_example'));
    assert.notEqual(digest, tokenDigest('gfx_other'));
  });
});

describe('cron', () => {
  test('parses the field forms schedules actually use', () => {
    assert.ok(isValidCron('0 7 * * *'));
    assert.ok(isValidCron('*/15 * * * *'));
    assert.ok(isValidCron('0 9 * * 1-5'));
    assert.ok(isValidCron('@daily'));
    assert.ok(isValidCron('30 8,17 * * mon-fri'));
    assert.ok(!isValidCron('0 7 * *'));
    assert.ok(!isValidCron('99 7 * * *'));
    assert.ok(!isValidCron(''));
  });

  test('computes the next daily occurrence', () => {
    const from = new Date(2026, 0, 15, 6, 30, 0);
    const next = nextCronDate('0 7 * * *', from);
    assert.equal(next.getHours(), 7);
    assert.equal(next.getMinutes(), 0);
    assert.equal(next.getDate(), 15);
  });

  test('rolls to tomorrow once today has passed', () => {
    const from = new Date(2026, 0, 15, 8, 0, 0);
    const next = nextCronDate('0 7 * * *', from);
    assert.equal(next.getDate(), 16);
    assert.equal(next.getHours(), 7);
  });

  test('honours weekday restrictions', () => {
    // 2026-01-17 is a Saturday, so weekdays-only lands on Monday the 19th.
    const next = nextCronDate('0 9 * * 1-5', new Date(2026, 0, 17, 12, 0, 0));
    assert.equal(next.getDay(), 1);
    assert.equal(next.getDate(), 19);
  });

  test('steps produce every nth minute', () => {
    const cron = parseCron('*/15 * * * *');
    assert.deepEqual([...cron.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  });
});

describe('workspace jail', () => {
  const root = path.resolve('/tmp/grotfoxy-jail-test');

  test('resolves ordinary relative paths', () => {
    assert.equal(resolveInWorkspace(root, 'notes.md'), path.join(root, 'notes.md'));
    assert.equal(resolveInWorkspace(root, 'a/b/c.txt'), path.join(root, 'a', 'b', 'c.txt'));
    assert.equal(resolveInWorkspace(root, '.'), root);
  });

  test('strips leading separators instead of escaping to the filesystem root', () => {
    assert.equal(resolveInWorkspace(root, '/etc/passwd'), path.join(root, 'etc', 'passwd'));
  });

  test('rejects traversal out of the workspace', () => {
    assert.throws(() => resolveInWorkspace(root, '../secrets.txt'), /escapes the bot workspace/);
    assert.throws(() => resolveInWorkspace(root, 'a/../../b'), /escapes the bot workspace/);
    assert.throws(() => resolveInWorkspace(root, '../../../../etc/shadow'), /escapes the bot workspace/);
  });

  test('does not treat a sibling with a shared prefix as inside', () => {
    assert.throws(() => resolveInWorkspace('/tmp/ws', '../ws-evil/file'), /escapes the bot workspace/);
  });
});

describe('shell guardrails', () => {
  test('blocks the destructive classics regardless of configuration', () => {
    assert.equal(checkCommandAllowed('rm -rf /').ok, false);
    assert.equal(checkCommandAllowed('mkfs.ext4 /dev/sda').ok, false);
    assert.equal(checkCommandAllowed(':(){ :|:& };:').ok, false);
    assert.equal(checkCommandAllowed('shutdown -h now').ok, false);
  });

  test('an allow list is exhaustive', () => {
    const allow = ['git', 'npm'];
    assert.equal(checkCommandAllowed('git status', { allow }).ok, true);
    assert.equal(checkCommandAllowed('npm test', { allow }).ok, true);
    assert.equal(checkCommandAllowed('curl http://example.com', { allow }).ok, false);
  });

  test('a deny list blocks matching substrings', () => {
    const deny = ['git push --force'];
    assert.equal(checkCommandAllowed('git push --force origin main', { deny }).ok, false);
    assert.equal(checkCommandAllowed('git push origin main', { deny }).ok, true);
  });

  test('an empty command is rejected', () => {
    assert.equal(checkCommandAllowed('   ').ok, false);
  });
});

describe('html extraction', () => {
  test('drops scripts and styles and keeps readable text', () => {
    const html = `
      <html><head><style>body{color:red}</style><script>alert('x')</script></head>
      <body><h1>Title</h1><p>First para &amp; more.</p><p>Second</p></body></html>`;
    const text = htmlToText(html);
    assert.ok(text.includes('Title'));
    assert.ok(text.includes('First para & more.'));
    assert.ok(text.includes('Second'));
    assert.ok(!text.includes('alert'));
    assert.ok(!text.includes('color:red'));
  });
});

describe('cost estimation', () => {
  test('local providers are always free', () => {
    assert.equal(
      estimateCost({ model: 'gpt-4o', kind: 'ollama', inputTokens: 1e6, outputTokens: 1e6 }),
      0,
    );
  });

  test('known hosted models are priced per million tokens', () => {
    const cost = estimateCost({ model: 'gpt-4o-mini', kind: 'openai', inputTokens: 1e6, outputTokens: 1e6 });
    assert.ok(cost > 0.7 && cost < 0.8, `expected ~0.75, got ${cost}`);
  });

  test('unknown models fall back to free rather than guessing', () => {
    assert.equal(
      estimateCost({ model: 'some-unlisted-model', kind: 'openai', inputTokens: 1e6, outputTokens: 1e6 }),
      0,
    );
  });
});

describe('tool call argument parsing', () => {
  test('parses well-formed JSON', () => {
    assert.deepEqual(safeParseArguments('{"path":"a.txt"}'), { path: 'a.txt' });
  });

  test('passes objects through untouched', () => {
    assert.deepEqual(safeParseArguments({ path: 'a.txt' }), { path: 'a.txt' });
  });

  test('salvages the object from noisy output', () => {
    assert.deepEqual(safeParseArguments('Sure! {"path":"a.txt"} hope that helps'), { path: 'a.txt' });
  });

  test('never throws on junk', () => {
    assert.deepEqual(safeParseArguments(''), {});
    assert.deepEqual(safeParseArguments('not json at all'), { _raw: 'not json at all' });
  });
});

describe('anthropic wire format', () => {
  test('hoists system messages and merges consecutive tool results', () => {
    const { system, messages } = anthropicAdapter.toWire([
      { role: 'system', content: 'You are a fox.' },
      { role: 'user', content: 'Do the thing.' },
      {
        role: 'assistant',
        content: 'Working on it.',
        toolCalls: [
          { id: 't1', name: 'read_file', arguments: { path: 'a' } },
          { id: 't2', name: 'read_file', arguments: { path: 'b' } },
        ],
      },
      { role: 'tool', toolCallId: 't1', content: 'contents of a' },
      { role: 'tool', toolCallId: 't2', content: 'contents of b' },
    ]);

    assert.equal(system, 'You are a fox.');
    assert.equal(messages.length, 3);
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[1].content.filter((block) => block.type === 'tool_use').length, 2);
    // Both results must arrive in a single user turn or the API rejects them.
    assert.equal(messages[2].role, 'user');
    assert.equal(messages[2].content.length, 2);
    assert.equal(messages[2].content[0].type, 'tool_result');
  });
});

describe('mcp transport', () => {
  test('reads a plain JSON-RPC body', () => {
    const parsed = parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', 1);
    assert.deepEqual(parsed.result, { ok: true });
  });

  test('picks the matching frame out of an SSE body', () => {
    const body = [
      'event: message',
      'data: {"jsonrpc":"2.0","id":9,"result":{"other":true}}',
      '',
      'event: message',
      'data: {"jsonrpc":"2.0","id":2,"result":{"mine":true}}',
      '',
    ].join('\n');
    assert.deepEqual(parseRpcBody(body, 2).result, { mine: true });
  });

  test('returns null for an empty body', () => {
    assert.equal(parseRpcBody('', 1), null);
  });
});

describe('mcp tool naming', () => {
  test('produces names models accept', () => {
    const name = mcpToolName('google-home', 'list.devices');
    assert.match(name, /^[a-zA-Z0-9_-]{1,64}$/);
    assert.ok(name.startsWith('mcp_google-home'));
  });

  test('stays within the 64 character limit', () => {
    const name = mcpToolName('a-very-long-connector-name-that-goes-on', 'an_extremely_long_tool_name_as_well');
    assert.ok(name.length <= 64, `got ${name.length}`);
    assert.match(name, /^[a-zA-Z0-9_-]+$/);
  });

  test('is deterministic', () => {
    assert.equal(mcpToolName('slack', 'post_message'), mcpToolName('slack', 'post_message'));
  });
});
