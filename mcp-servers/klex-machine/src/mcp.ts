import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod/v4';

import {
  FilesystemService,
  MachinePathResolver,
  SearchService,
} from './filesystem/index.js';
import { ShellService } from './shell/index.js';

export interface MachineMcp {
  fetch(request: Request): Promise<Response>;
  close(): Promise<void>;
}

class MachineMcpModule implements MachineMcp {
  readonly #handler: ReturnType<typeof createMcpHandler>;
  readonly #shell: ShellService;

  constructor(defaultCwd: string) {
    const paths = new MachinePathResolver(defaultCwd);
    const filesystem = new FilesystemService(paths);
    const search = new SearchService(paths);
    this.#shell = new ShellService(paths);
    this.#handler = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: 'klex-machine', version: '0.1.0' },
          {
            capabilities: {},
            instructions: `UNRESTRICTED MACHINE ACCESS. Filesystem and shell operations run with the permissions of the server OS user. Relative paths resolve from ${defaultCwd}. Operating system: ${process.platform}.`,
          },
        );

        server.registerTool(
          'read',
          {
            description: 'Read a UTF-8 or base64 file. Access is unrestricted.',
            inputSchema: z.object({
              path: z.string().min(1),
              encoding: z.enum(['utf8', 'base64']).optional(),
              startLine: z.number().int().positive().optional(),
              endLine: z.number().int().positive().optional(),
            }),
          },
          (input) => result(() => filesystem.read(input)),
        );
        server.registerTool(
          'list',
          {
            description:
              'List a directory with metadata. Access is unrestricted.',
            inputSchema: z.object({ path: z.string().min(1) }),
          },
          ({ path }) => result(() => filesystem.list(path)),
        );
        server.registerTool(
          'write',
          {
            description: 'Atomically write a UTF-8 or base64 file.',
            inputSchema: z.object({
              path: z.string().min(1),
              content: z.string(),
              encoding: z.enum(['utf8', 'base64']).optional(),
            }),
          },
          (input) => result(() => filesystem.write(input)),
        );
        server.registerTool(
          'multiEdit',
          {
            description: 'Apply sequential exact text replacements atomically.',
            inputSchema: z.object({
              path: z.string().min(1),
              edits: z
                .array(
                  z.object({
                    oldString: z.string(),
                    newString: z.string(),
                    replaceAll: z.boolean().optional(),
                  }),
                )
                .min(1),
            }),
          },
          ({ path, edits }) => result(() => filesystem.multiEdit(path, edits)),
        );
        server.registerTool(
          'mkdir',
          {
            description: 'Recursively create a directory.',
            inputSchema: z.object({ path: z.string().min(1) }),
          },
          ({ path }) => result(() => filesystem.mkdir(path)),
        );
        server.registerTool(
          'delete',
          {
            description: 'Permanently delete a file or directory tree.',
            inputSchema: z.object({ path: z.string().min(1) }),
          },
          ({ path }) => result(() => filesystem.delete(path)),
        );
        server.registerTool(
          'copy',
          {
            description: 'Copy or move a file, symlink, or directory tree.',
            inputSchema: z.object({
              source: z.string().min(1),
              destination: z.string().min(1),
              move: z.boolean().optional(),
              overwrite: z.boolean().optional(),
            }),
          },
          (input) => result(() => filesystem.copy(input)),
        );
        server.registerTool(
          'glob',
          {
            description: 'Find paths using bounded glob patterns.',
            inputSchema: z.object({
              patterns: z.array(z.string().min(1)).min(1),
              cwd: z.string().min(1).optional(),
              exclude: z.array(z.string()).optional(),
              hidden: z.boolean().optional(),
              gitignore: z.boolean().optional(),
              limit: z.number().int().positive().optional(),
            }),
          },
          (input) => result(() => search.glob(input)),
        );
        server.registerTool(
          'grepSearch',
          {
            description:
              'Search bounded text files using a regular expression.',
            inputSchema: z.object({
              pattern: z.string().min(1),
              cwd: z.string().min(1).optional(),
              include: z.array(z.string()).optional(),
              exclude: z.array(z.string()).optional(),
              caseSensitive: z.boolean().optional(),
              hidden: z.boolean().optional(),
              gitignore: z.boolean().optional(),
              context: z.number().int().min(0).max(20).optional(),
              limit: z.number().int().positive().optional(),
            }),
          },
          (input) => result(() => search.grep(input)),
        );
        server.registerTool(
          'createShellSession',
          {
            description: 'Create an unrestricted persistent PTY shell session.',
            inputSchema: z.object({
              cwd: z.string().min(1).optional(),
              shell: z.string().min(1).optional(),
              args: z.array(z.string()).optional(),
              cols: z.number().int().positive().optional(),
              rows: z.number().int().positive().optional(),
              env: z.record(z.string(), z.string()).optional(),
            }),
          },
          (input) => result(() => this.#shell.create(input)),
        );
        server.registerTool(
          'writeShellSession',
          {
            description: 'Write raw input to a persistent PTY session.',
            inputSchema: z.object({
              id: z.string().uuid(),
              data: z.string(),
            }),
          },
          ({ id, data }) => result(() => this.#shell.write(id, data)),
        );
        server.registerTool(
          'readShellSession',
          {
            description: 'Read PTY output using a monotonic cursor.',
            inputSchema: z.object({
              id: z.string().uuid(),
              cursor: z.number().int().min(0).optional(),
              waitMs: z.number().int().min(0).max(30_000).optional(),
            }),
          },
          (input) => result(() => this.#shell.read(input)),
        );
        server.registerTool(
          'resizeShellSession',
          {
            description: 'Resize a persistent PTY session.',
            inputSchema: z.object({
              id: z.string().uuid(),
              cols: z.number().int().positive(),
              rows: z.number().int().positive(),
            }),
          },
          ({ id, cols, rows }) =>
            result(() => this.#shell.resize(id, cols, rows)),
        );
        server.registerTool(
          'closeShellSession',
          {
            description: 'Terminate and remove a persistent PTY session.',
            inputSchema: z.object({ id: z.string().uuid() }),
          },
          ({ id }) => result(() => this.#shell.close(id)),
        );
        server.registerTool(
          'listShellSessions',
          {
            description: 'List persistent PTY sessions and exit states.',
            inputSchema: z.object({}),
          },
          () => result(() => this.#shell.list()),
        );
        return server;
      },
      { legacy: 'stateless' },
    );
  }

  fetch(request: Request): Promise<Response> {
    return this.#handler.fetch(request);
  }

  async close(): Promise<void> {
    this.#shell.closeAll();
    await this.#handler.close();
  }
}

export function createMachineMcp(defaultCwd: string): MachineMcp {
  return new MachineMcpModule(defaultCwd);
}

async function result(operation: () => unknown | Promise<unknown>) {
  try {
    const value = await operation();
    return {
      content: [
        { type: 'text' as const, text: JSON.stringify(value ?? { ok: true }) },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true as const,
    };
  }
}
