import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import log from '../core/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let database = null;

/**
 * node:sqlite only binds null, numbers, bigints, strings and buffers. Booleans,
 * undefined and objects are common enough in call sites that normalising here
 * is cheaper than remembering at every query.
 */
function normalize(params) {
  return params.map((value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'object' && !(value instanceof Uint8Array)) return JSON.stringify(value);
    return value;
  });
}

/** Rows come back with a null prototype, which trips up spread/JSON in places. */
function plain(row) {
  return row ? { ...row } : row;
}

export function openDatabase(file = config.databaseFile) {
  if (database) return database;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  database = new DatabaseSync(file);
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA busy_timeout = 5000;');
  database.exec('PRAGMA synchronous = NORMAL;');
  const schema = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');
  database.exec(schema);
  migrate(database);
  log.debug(`database ready at ${file}`);
  return database;
}

/**
 * `CREATE TABLE IF NOT EXISTS` does nothing for a database that already exists,
 * so columns added after a release need backfilling here. GrotFoxy instances
 * live on one machine for a long time and are upgraded by pulling; they never
 * get a fresh database.
 */
const ADDED_COLUMNS = [
  ['bots', 'parallel_tools', 'INTEGER NOT NULL DEFAULT 0'],
  ['runs', 'active_ms', 'INTEGER NOT NULL DEFAULT 0'],
  ['approvals', 'kind', "TEXT NOT NULL DEFAULT 'approval'"],
  ['approvals', 'tool_call_id', "TEXT NOT NULL DEFAULT ''"],
];

function migrate(handle) {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const exists = handle
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((row) => row.name === column);
    if (exists) continue;
    handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    log.info(`migrated: added ${table}.${column}`);
  }
}

export function db() {
  return database ?? openDatabase();
}

export function run(sql, ...params) {
  return db().prepare(sql).run(...normalize(params));
}

export function get(sql, ...params) {
  return plain(db().prepare(sql).get(...normalize(params)));
}

export function all(sql, ...params) {
  return db()
    .prepare(sql)
    .all(...normalize(params))
    .map(plain);
}

export function transaction(fn) {
  const handle = db();
  handle.exec('BEGIN');
  try {
    const result = fn();
    handle.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      handle.exec('ROLLBACK');
    } catch {
      // A rollback failure means the transaction was already unwound; the
      // original error below is the one worth surfacing.
    }
    throw error;
  }
}

export function closeDatabase() {
  if (database) {
    database.close();
    database = null;
  }
}

export function now() {
  return new Date().toISOString();
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const settings = {
  get(key, fallback = null) {
    const row = get('SELECT value FROM settings WHERE key = ?', key);
    return row ? parseJson(row.value, fallback) : fallback;
  },
  set(key, value) {
    run(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      JSON.stringify(value ?? null),
      now(),
    );
    return value;
  },
  all() {
    const out = {};
    for (const row of all('SELECT key, value FROM settings')) {
      out[row.key] = parseJson(row.value, null);
    }
    return out;
  },
};
