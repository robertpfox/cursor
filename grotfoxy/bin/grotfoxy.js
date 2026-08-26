#!/usr/bin/env node
import os from 'node:os';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import config from '../src/config.js';
import bootstrap from '../src/bootstrap.js';
import { all, get } from '../src/db/index.js';
import { createUser, needsSetup, setPassword } from '../src/server/auth.js';
import { listProviders, testProvider } from '../src/services/providers.js';
import { listConnectors, testConnector } from '../src/services/connectors.js';
import { listBots } from '../src/services/bots.js';

const [command, ...args] = process.argv.slice(2);

async function prompt(question, { silent = false } = {}) {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
  if (!silent) {
    const answer = await rl.question(question);
    rl.close();
    return answer.trim();
  }
  // Suppress echo so a typed password does not land in the scrollback.
  const originalWrite = stdout.write.bind(stdout);
  stdout.write(question);
  stdout.write = (chunk, ...rest) =>
    typeof chunk === 'string' && chunk.trim() ? true : originalWrite(chunk, ...rest);
  const answer = await rl.question('');
  stdout.write = originalWrite;
  stdout.write('\n');
  rl.close();
  return answer.trim();
}

function ok(text) {
  console.log(`\u2713 ${text}`);
}
function fail(text) {
  console.log(`\u2717 ${text}`);
}

async function cmdCreateOwner() {
  bootstrap();
  if (!needsSetup()) {
    fail('This instance already has an owner. Use `reset-password` instead.');
    process.exit(1);
  }
  const username = args[0] || (await prompt('Username: '));
  const password = args[1] || (await prompt('Password (min 8 chars): ', { silent: true }));
  createUser({ username, password, displayName: username });
  ok(`Owner "${username}" created. Sign in at http://localhost:${config.port}`);
}

async function cmdResetPassword() {
  bootstrap();
  const users = all('SELECT username FROM users ORDER BY created_at');
  if (!users.length) {
    fail('No users yet. Run `grotfoxy create-owner` first.');
    process.exit(1);
  }
  const username = args[0] || users[0].username;
  const password = args[1] || (await prompt(`New password for "${username}": `, { silent: true }));
  setPassword(username, password);
  ok(`Password updated for "${username}". All existing sessions were signed out.`);
}

async function cmdDoctor() {
  bootstrap();
  console.log(`\nGrotFoxy v${config.version} health check`);
  console.log(`  host        ${os.hostname()} (${os.platform()} ${os.arch()})`);
  console.log(`  node        ${process.version}`);
  console.log(`  data dir    ${config.dataDir}`);
  console.log(`  workspace   ${config.workspaceDir}`);
  console.log(`  listen      ${config.host}:${config.port}\n`);

  const owner = get('SELECT username FROM users ORDER BY created_at LIMIT 1');
  if (owner) ok(`owner account: ${owner.username}`);
  else fail('no owner account yet \u2014 open the web UI or run `create-owner`');

  const providers = listProviders();
  if (!providers.length) fail('no model providers configured');
  for (const provider of providers.filter((entry) => entry.enabled)) {
    const result = await testProvider(provider.id);
    if (result.ok) ok(`provider "${provider.name}" reachable (${result.models.length} models)`);
    else fail(`provider "${provider.name}": ${result.error}`);
  }

  const connectors = listConnectors().filter((entry) => entry.enabled);
  if (!connectors.length) console.log('  (no connectors enabled)');
  for (const connector of connectors) {
    const result = await testConnector(connector.id);
    if (result.ok) ok(`connector "${connector.name}" ready (${result.tools.length} tools)`);
    else fail(`connector "${connector.name}": ${result.error}`);
  }

  const bots = listBots();
  console.log(`\n  ${bots.length} teammate(s), ${bots.filter((bot) => bot.scheduleOn).length} on a schedule`);
  process.exit(0);
}

function usage() {
  console.log(`
GrotFoxy CLI

  grotfoxy create-owner [username] [password]   Create the first account
  grotfoxy reset-password [username] [password] Reset a password and sign out sessions
  grotfoxy doctor                               Check providers, connectors and config

Start the server with: npm start
`);
}

const commands = {
  'create-owner': cmdCreateOwner,
  'reset-password': cmdResetPassword,
  doctor: cmdDoctor,
};

const handler = commands[command];
if (!handler) {
  usage();
  process.exit(command ? 1 : 0);
}

handler().catch((error) => {
  fail(error.message);
  process.exit(1);
});
