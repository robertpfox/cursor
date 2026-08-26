import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Imported first by every test file so `src/config.js` reads a throwaway data
 * directory. ESM evaluates imports in declaration order, so listing this above
 * the application imports is enough.
 */
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grotfoxy-test-'));

process.env.GROTFOXY_DATA_DIR = path.join(root, 'data');
process.env.GROTFOXY_WORKSPACE_DIR = path.join(root, 'workspace');
process.env.GROTFOXY_SECRET = 'test-secret-not-used-anywhere-real';
process.env.GROTFOXY_LOG_LEVEL = 'silent';
process.env.GROTFOXY_SCHEDULER = 'false';
process.env.GROTFOXY_PORT = '0';

export const testRoot = root;

process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // Best effort; the OS reclaims the temp dir anyway.
  }
});
