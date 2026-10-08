import type { GenerateTextArgs, GenerateTextResult } from '../extension-api';

/** Fake SDK execution for the JSON-encoded model-call fixtures in worker tests. */
export async function executeFixtureSubmission(
  args: GenerateTextArgs,
  reply: GenerateTextResult,
): Promise<GenerateTextResult> {
  if (!reply.success || reply.toolResults !== undefined) return reply;
  let input: unknown;
  try {
    input = JSON.parse(reply.text);
  } catch {
    return { ...reply, toolResults: [] };
  }
  const execute = args.tools?.submitLearnings?.execute;
  if (!execute) throw new Error('Missing submitLearnings tool');
  const output = await execute(input, {
    toolCallId: 'fixture-submit',
    messages: [],
    context: undefined,
    abortSignal: args.abortSignal,
  });
  return { ...reply, toolResults: [{ toolName: 'submitLearnings', output }] };
}
