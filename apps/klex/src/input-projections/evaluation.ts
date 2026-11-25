import { catalog } from './catalog';
import { type GenerationOptions, generatePlan } from './generator';
import { select } from './projection';

/** Explicitly invoked only; callers supply the normal Chat generation callback. No CI network calls. */
export async function evaluateInputProjection(
  value: unknown,
  options: GenerationOptions,
  assertSemantics: (projected: unknown) => boolean,
) {
  const input = catalog(value);
  const started = Date.now();
  let attempts = 0;
  let reportedInputTokens = 0;
  let reportedOutputTokens = 0;
  const plan = await generatePlan(input, {
    ...options,
    generate: async (args) => {
      attempts++;
      const result = await options.generate(args);
      if (result.success) {
        reportedInputTokens += result.usage.inputTokens ?? 0;
        reportedOutputTokens += result.usage.outputTokens ?? 0;
      }
      return result;
    },
  });
  const projected = plan ? select(plan, value, 'default') : undefined;
  return {
    valid: plan !== undefined,
    semantics: plan ? assertSemantics(projected) : false,
    reduction: plan
      ? 1 - Buffer.byteLength(JSON.stringify(projected)) / input.bytes
      : null,
    attempts,
    latencyMs: Date.now() - started,
    reportedInputTokens,
    reportedOutputTokens,
  };
}
