import { isStepCount } from 'ai';

import type { GenerateTextArgs } from '../extensions/extension-api';

/** Preserve single-step defaults unless an extension opts into bounded tools. */
export function extensionGenerationOptions(args: GenerateTextArgs) {
  if (args.maxSteps === undefined) return { abortSignal: args.abortSignal };
  if (!Number.isFinite(args.maxSteps))
    throw new RangeError('maxSteps must be finite');
  const steps = Math.max(1, Math.min(20, Math.floor(args.maxSteps)));
  return {
    abortSignal: args.abortSignal,
    stopWhen: isStepCount(steps),
    prepareStep: ({ stepNumber }: { stepNumber: number }) =>
      stepNumber >= steps - 1
        ? { toolChoice: 'none' as const, activeTools: [] }
        : {},
  };
}
