import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import config from '../config.js';
import log from './logger.js';

const LOCK_FILE = path.join(config.dataDir, 'instance.lock');

/**
 * Two GrotFoxy processes pointed at one database is not a harmless duplicate:
 * each runs its own scheduler, so every cron job fires twice, and each thinks
 * it owns the run queue. It happens easily — a second install, a stray
 * `npm start` next to the service — so refuse rather than corrupt.
 */
export function acquireInstanceLock() {
  const existing = readLock();
  if (existing && isAlive(existing.pid)) {
    const error = new Error(
      [
        `Another GrotFoxy is already using ${config.dataDir}.`,
        `It is process ${existing.pid} on ${existing.host}, started ${existing.startedAt}, serving port ${existing.port}.`,
        'Stop it first, or point this one at a different GROTFOXY_DATA_DIR.',
      ].join('\n'),
    );
    error.code = 'EGROTFOXYLOCKED';
    throw error;
  }
  if (existing) {
    log.warn(`clearing a stale lock from pid ${existing.pid} (no longer running)`);
  }

  fs.writeFileSync(
    LOCK_FILE,
    JSON.stringify({
      pid: process.pid,
      host: os.hostname(),
      port: config.port,
      startedAt: new Date().toISOString(),
    }),
  );

  const release = () => releaseInstanceLock();
  process.once('exit', release);
  return release;
}

export function releaseInstanceLock() {
  const existing = readLock();
  // Only clear our own lock; a crashed predecessor's file is not ours to remove
  // on the way out.
  if (existing?.pid === process.pid) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* already gone */
    }
  }
}

function readLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    return Number.isInteger(parsed?.pid) ? parsed : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user — still running.
    return error.code === 'EPERM';
  }
}
