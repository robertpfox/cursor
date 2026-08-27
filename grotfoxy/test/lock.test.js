import '../test/helpers/env.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { afterEach, describe } from 'node:test';

import config from '../src/config.js';
import { acquireInstanceLock, releaseInstanceLock } from '../src/core/lock.js';

const LOCK_FILE = path.join(config.dataDir, 'instance.lock');

function writeLock(contents) {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.writeFileSync(LOCK_FILE, JSON.stringify(contents));
}

afterEach(() => {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    /* nothing to clean up */
  }
});

describe('instance lock', () => {
  test('claims the data directory and records who holds it', () => {
    acquireInstanceLock();
    const held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.equal(held.port, config.port);
    assert.ok(held.host);
    assert.ok(Date.parse(held.startedAt) > 0);
  });

  test('refuses to start when a live process already holds it', () => {
    // PID 1 always exists, so it stands in for a running sibling instance.
    writeLock({ pid: 1, host: 'den', port: 8787, startedAt: new Date().toISOString() });
    assert.throws(
      () => acquireInstanceLock(),
      (error) => {
        assert.equal(error.code, 'EGROTFOXYLOCKED');
        assert.match(error.message, /Another GrotFoxy is already using/);
        assert.match(error.message, /process 1 on den/);
        assert.match(error.message, /GROTFOXY_DATA_DIR/);
        return true;
      },
    );
  });

  test('takes over a stale lock left by a dead process', () => {
    // Very high pid that is not in use; a crashed predecessor must not wedge
    // the install permanently.
    writeLock({ pid: 4194303, host: 'den', port: 8787, startedAt: new Date().toISOString() });
    acquireInstanceLock();
    assert.equal(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid, process.pid);
  });

  test('ignores a corrupt lock file rather than refusing to boot', () => {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(LOCK_FILE, 'not json at all');
    acquireInstanceLock();
    assert.equal(JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')).pid, process.pid);
  });

  test('releasing removes only our own lock', () => {
    acquireInstanceLock();
    releaseInstanceLock();
    assert.equal(fs.existsSync(LOCK_FILE), false);

    writeLock({ pid: 1, host: 'someone-else', port: 9999, startedAt: new Date().toISOString() });
    releaseInstanceLock();
    assert.equal(fs.existsSync(LOCK_FILE), true, 'another process\u2019s lock must survive');
  });
});
