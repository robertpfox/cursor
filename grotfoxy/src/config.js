import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(here, '..');

/**
 * Minimal `.env` reader. GrotFoxy ships with zero runtime dependencies so that
 * installing it on a home machine never needs a compiler or a package registry.
 */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(APP_ROOT, '.env'));

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name, fallback) {
  const parsed = Number.parseInt(env(name, ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const value = env(name, '');
  if (value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

const dataDir = path.resolve(env('GROTFOXY_DATA_DIR', path.join(APP_ROOT, 'data')));
fs.mkdirSync(dataDir, { recursive: true });

const workspaceDir = path.resolve(
  env('GROTFOXY_WORKSPACE_DIR', path.join(APP_ROOT, 'workspace')),
);
fs.mkdirSync(workspaceDir, { recursive: true });

/**
 * The master key encrypts provider API keys and connector secrets at rest. It
 * is generated once and stored beside the database with owner-only permissions
 * so a stolen `grotfoxy.db` alone does not leak credentials.
 */
function loadOrCreateMasterKey() {
  const fromEnv = env('GROTFOXY_SECRET', '');
  if (fromEnv) return crypto.createHash('sha256').update(fromEnv).digest();

  const keyFile = path.join(dataDir, 'master.key');
  if (fs.existsSync(keyFile)) {
    return Buffer.from(fs.readFileSync(keyFile, 'utf8').trim(), 'hex');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key.toString('hex'), { mode: 0o600 });
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {
    // Windows ACLs do not map onto POSIX modes; the file still lands in a
    // user-profile directory, which is the practical protection there.
  }
  return key;
}

export const config = {
  appRoot: APP_ROOT,
  publicDir: path.join(APP_ROOT, 'public'),
  dataDir,
  workspaceDir,
  databaseFile: path.join(dataDir, 'grotfoxy.db'),
  host: env('GROTFOXY_HOST', '0.0.0.0'),
  port: envInt('GROTFOXY_PORT', 8787),
  logLevel: env('GROTFOXY_LOG_LEVEL', 'info'),
  masterKey: loadOrCreateMasterKey(),
  sessionTtlDays: envInt('GROTFOXY_SESSION_TTL_DAYS', 30),
  // Setup mode lets the very first visitor claim the instance. Disable it on a
  // machine that is exposed beyond the LAN and provision the owner via the CLI.
  allowSetup: envBool('GROTFOXY_ALLOW_SETUP', true),
  /**
   * Serve only callers on your own network. On by default: this is a home
   * server that binds 0.0.0.0 so your phone can reach it, and that same bind
   * answers a port forward or a tunnel just as happily. Set false only when
   * something in front of it is doing the access control.
   */
  lanOnly: envBool('GROTFOXY_LAN_ONLY', true),
  schedulerEnabled: envBool('GROTFOXY_SCHEDULER', true),
  maxConcurrentRuns: envInt('GROTFOXY_MAX_CONCURRENT_RUNS', 3),
  /**
   * Instance-wide tool kill switch, e.g. GROTFOXY_DISABLE_TOOLS=run_command.
   * Enforced in the runtime rather than per bot, so it still holds if someone
   * with the password edits a bot and ticks the box back on. Set this on any
   * instance reachable from beyond your own network.
   */
  disabledTools: env('GROTFOXY_DISABLE_TOOLS', '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean),
  version: '1.0.0',
};

export default config;
