import { spawn } from 'node:child_process';
import os from 'node:os';
import { resolveInWorkspace } from './files.js';

const DEFAULT_DENY = [
  /\brm\s+-rf\s+\/(?!\w)/i,
  /\bmkfs\b/i,
  /\bdd\s+if=.*of=\/dev\//i,
  /\bformat\s+[a-z]:/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /Remove-Item.*-Recurse.*[Cc]:\\\\?\s*$/,
  /:\(\)\s*\{.*\};\s*:/, // fork bomb
];

function shellFor() {
  if (os.platform() === 'win32') {
    return { file: process.env.ComSpec || 'cmd.exe', prefix: ['/d', '/s', '/c'] };
  }
  return { file: '/bin/sh', prefix: ['-c'] };
}

export function checkCommandAllowed(command, { allow = [], deny = [] } = {}) {
  const text = String(command ?? '');
  if (!text.trim()) return { ok: false, reason: 'Empty command' };

  for (const pattern of DEFAULT_DENY) {
    if (pattern.test(text)) {
      return { ok: false, reason: `Blocked by GrotFoxy's built-in safety list (${pattern})` };
    }
  }
  for (const entry of deny) {
    if (entry && text.toLowerCase().includes(String(entry).toLowerCase())) {
      return { ok: false, reason: `Blocked by this bot's deny list ("${entry}")` };
    }
  }
  // An allow list, when present, is exhaustive: the command must start with one
  // of the permitted programs.
  if (allow.length) {
    const first = text.trim().split(/\s+/)[0].toLowerCase();
    const permitted = allow.some((entry) => {
      const name = String(entry).toLowerCase();
      return first === name || first.endsWith(`/${name}`) || first.endsWith(`\\${name}`);
    });
    if (!permitted) {
      return { ok: false, reason: `"${first}" is not in this bot's allowed command list` };
    }
  }
  return { ok: true };
}

export const shellTools = [
  {
    name: 'run_command',
    group: 'shell',
    sensitivity: 'dangerous',
    description:
      'Run a shell command on the host machine. Working directory defaults to the bot workspace.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to execute.' },
        cwd: { type: 'string', description: 'Optional working directory relative to the workspace root.' },
        timeout_seconds: { type: 'number', description: 'Kill the command after this many seconds (default 120).' },
      },
      required: ['command'],
    },
    async execute({ command, cwd, timeout_seconds: timeoutSeconds }, ctx) {
      const verdict = checkCommandAllowed(command, {
        allow: ctx.bot.shellAllow,
        deny: ctx.bot.shellDeny,
      });
      if (!verdict.ok) throw new Error(verdict.reason);

      const workDir = resolveInWorkspace(ctx.workspaceDir, cwd || '.');
      const timeoutMs = Math.min(Math.max(Number(timeoutSeconds) || 120, 1), 900) * 1000;
      const { file, prefix } = shellFor();

      return new Promise((resolve, reject) => {
        const child = spawn(file, [...prefix, command], {
          cwd: workDir,
          env: { ...process.env, GROTFOXY_BOT: ctx.bot.name, GROTFOXY_RUN: ctx.run.id },
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill('SIGKILL');
          resolve({
            output: `Command timed out after ${timeoutMs / 1000}s.\n--- stdout ---\n${clip(stdout)}\n--- stderr ---\n${clip(stderr)}`,
            meta: { timedOut: true },
          });
        }, timeoutMs);

        const onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          reject(new Error('Run cancelled'));
        };
        ctx.signal?.addEventListener('abort', onAbort, { once: true });

        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        child.on('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx.signal?.removeEventListener('abort', onAbort);
          resolve({
            output: [
              `exit code: ${code}`,
              stdout.trim() ? `--- stdout ---\n${clip(stdout)}` : '(no stdout)',
              stderr.trim() ? `--- stderr ---\n${clip(stderr)}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            meta: { exitCode: code },
          });
        });
      });
    },
  },
];

function clip(text, limit = 20_000) {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}\n[output truncated]` : value;
}

export default shellTools;
