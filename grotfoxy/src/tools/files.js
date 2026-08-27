import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Every path a bot touches is resolved inside its workspace directory. This is
 * the hard half of "boundaries": the prompt asks nicely, this makes it true.
 */
export function resolveInWorkspace(workspaceDir, relative) {
  const root = path.resolve(workspaceDir);
  const target = path.resolve(root, String(relative ?? '.').replace(/^[/\\]+/, ''));
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the bot workspace: ${relative}`);
  }
  return target;
}

const MAX_READ_BYTES = 200_000;

export const fileTools = [
  {
    name: 'list_files',
    group: 'files',
    sensitivity: 'safe',
    description: 'List files and folders inside the bot workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Folder relative to the workspace root. Defaults to the root.' },
      },
    },
    async execute({ path: rel = '.' }, ctx) {
      const dir = resolveInWorkspace(ctx.workspaceDir, rel);
      const entries = await fs.readdir(dir, { withFileTypes: true });
      if (!entries.length) return { output: `(empty folder: ${rel})` };
      const lines = await Promise.all(
        entries.map(async (entry) => {
          if (entry.isDirectory()) return `dir   ${entry.name}/`;
          const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
          return `file  ${entry.name}${stat ? `  (${stat.size} bytes)` : ''}`;
        }),
      );
      return { output: lines.sort().join('\n') };
    },
  },
  {
    name: 'read_file',
    group: 'files',
    sensitivity: 'safe',
    description: 'Read a UTF-8 text file from the bot workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'File path relative to the workspace root.' } },
      required: ['path'],
    },
    async execute({ path: rel }, ctx) {
      const file = resolveInWorkspace(ctx.workspaceDir, rel);
      const buffer = await fs.readFile(file);
      const truncated = buffer.length > MAX_READ_BYTES;
      const text = buffer.subarray(0, MAX_READ_BYTES).toString('utf8');
      return {
        output: truncated ? `${text}\n\n[truncated at ${MAX_READ_BYTES} bytes]` : text,
        meta: { bytes: buffer.length },
      };
    },
  },
  {
    name: 'write_file',
    group: 'files',
    sensitivity: 'sensitive',
    description: 'Create or overwrite a text file in the bot workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'Full file contents to write.' },
      },
      required: ['path', 'content'],
    },
    async execute({ path: rel, content }, ctx) {
      const file = resolveInWorkspace(ctx.workspaceDir, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, String(content ?? ''), 'utf8');
      return { output: `Wrote ${Buffer.byteLength(String(content ?? ''))} bytes to ${rel}` };
    },
  },
  {
    name: 'append_file',
    group: 'files',
    sensitivity: 'sensitive',
    description: 'Append text to a file in the bot workspace, creating it if needed.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async execute({ path: rel, content }, ctx) {
      const file = resolveInWorkspace(ctx.workspaceDir, rel);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.appendFile(file, String(content ?? ''), 'utf8');
      return { output: `Appended to ${rel}` };
    },
  },
  {
    name: 'delete_file',
    group: 'files',
    sensitivity: 'dangerous',
    description: 'Delete a file or folder from the bot workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    async execute({ path: rel }, ctx) {
      const target = resolveInWorkspace(ctx.workspaceDir, rel);
      if (target === path.resolve(ctx.workspaceDir)) {
        throw new Error('Refusing to delete the workspace root');
      }
      await fs.rm(target, { recursive: true, force: true });
      return { output: `Deleted ${rel}` };
    },
  },
];

export default fileTools;
