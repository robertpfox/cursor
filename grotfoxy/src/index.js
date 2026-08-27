import os from 'node:os';
import config from './config.js';
import log from './core/logger.js';
import bootstrap from './bootstrap.js';
import { closeDatabase } from './db/index.js';
import { acquireInstanceLock, releaseInstanceLock } from './core/lock.js';
import { purgeExpiredSessions } from './server/auth.js';
import { startServer } from './server/index.js';
import { recoverInterruptedRuns } from './runtime/runner.js';
import { startScheduler, stopScheduler } from './runtime/scheduler.js';
import { disconnectAll } from './services/connectors.js';

function lanAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

async function main() {
  bootstrap();
  acquireInstanceLock();
  purgeExpiredSessions();

  const recovered = recoverInterruptedRuns();
  if (recovered) log.info(`resumed ${recovered} run(s) interrupted by the last shutdown`);

  const server = await startServer();
  startScheduler();

  const banner = [
    '',
    `  GrotFoxy v${config.version} \u2014 your teammates are on ${os.hostname()}`,
    '',
    `  Local:   http://localhost:${config.port}`,
    ...lanAddresses().map((address) => `  Network: http://${address}:${config.port}`),
    '',
    `  Data:      ${config.dataDir}`,
    `  Workspace: ${config.workspaceDir}`,
    '',
  ].join('\n');
  console.log(banner);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    stopScheduler();
    disconnectAll();
    releaseInstanceLock();
    server.close(() => {
      closeDatabase();
      process.exit(0);
    });
    // Long-poll SSE clients hold the server open; do not wait on them forever.
    setTimeout(() => process.exit(0), 4000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log.error(`unhandled rejection: ${reason?.stack ?? reason}`);
  });
}

main().catch((error) => {
  if (error.code === 'EGROTFOXYLOCKED') {
    // Not a crash, and not something a supervisor should retry into a loop.
    const indented = error.message.split('\n').map((line) => `  ${line}`).join('\n');
    console.error(`\n${indented}\n`);
    process.exit(2);
  }
  log.error(`GrotFoxy failed to start: ${error.stack ?? error.message}`);
  process.exit(1);
});
