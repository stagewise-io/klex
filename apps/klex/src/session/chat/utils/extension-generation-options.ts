import { isStepCount, type StopCondition, type ToolSet } from 'ai';

import type { GenerateTextArgs } from '../extensions/extension-api';

/** Preserve single-step defaults unless an extension opts into bounded tools. */
export function extensionGenerationOptions(args: GenerateTextArgs) {
  const completion = args.completionTool;
  if (completion && !args.tools?.[completion.name])
    throw new Error('Completion tool must be registered');
  if (args.maxSteps === undefined && !completion)
    return { abortSignal: args.abortSignal };
  const maxSteps = args.maxSteps ?? 1;
  if (!Number.isFinite(maxSteps))
    throw new RangeError('maxSteps must be finite');
  const steps = Math.max(1, Math.min(20, Math.floor(maxSteps)));
  const submitted: StopCondition<ToolSet> = ({ steps }) =>
    completion !== undefined &&
    steps.some((step) =>
      step.toolResults.some(
        (result) =>
          result.toolName === completion.name &&
          completion.isComplete(result.output),
      ),
    );
  return {
    abortSignal: args.abortSignal,
    stopWhen: completion ? [isStepCount(steps), submitted] : isStepCount(steps),
    prepareStep: ({ stepNumber }: { stepNumber: number }) => {
      if (completion)
        return stepNumber >= steps - 1
          ? {
              toolChoice: { type: 'tool' as const, toolName: completion.name },
              activeTools: [completion.name],
            }
          : { toolChoice: 'required' as const };
      return stepNumber >= steps - 1
        ? { toolChoice: 'none' as const, activeTools: [] }
        : {};
    },
  };
}
