import type { ToolSet } from 'ai';
import z from 'zod';

export const getMemoryTools = () => {
  return {
    memorize: {
      inputSchema: z.object({
        content: z
          .string()
          .describe(
            "The information to memorize (Example: 'The user's name is John Doe.').",
          ),
      }),
      execute: async (input: string) => {
        // TODO
      },
    },
    remember: {
      inputSchema: z.object({
        question: z
          .string()
          .describe(
            'Question that asks what should be retrieved from memory (Example: "What\'s the name of the user?").',
          ),
      }),
      outputSchema: z.string().describe('The answer to the question.'),
      execute: async (input: string) => {
        // TODO
        return 'Not implemented yet!';
      },
    },
  } satisfies ToolSet;
};
