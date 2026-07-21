import type { ToolSet } from 'ai';
import z from 'zod';

export const getReplSandboxTools = () => {
  return {
    run: {
      inputSchema: z.object({
        code: z
          .string()
          .describe(
            'JavaScript code that should be run inside the REPL environment.',
          ),
      }),
      outputSchema: z.string().describe('The output of the executed code.'),
      execute: async (_input: string) => {
        // TODO
        return 'REPL environment implemented yet!';
      },
    },
  } satisfies ToolSet;
};
