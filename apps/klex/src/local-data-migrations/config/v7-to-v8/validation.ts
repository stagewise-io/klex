import { z } from 'zod';

// Validate without replacing the payload: preserve unknown persisted fields.
export function preservingSchema(
  validate: (value: Record<string, unknown>) => unknown,
): z.ZodType<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).superRefine((value, context) => {
    try {
      validate(value);
    } catch (error) {
      if (error instanceof z.ZodError) {
        for (const issue of error.issues)
          context.addIssue({
            code: 'custom',
            path: issue.path,
            message: issue.message,
          });
        return;
      }
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid config',
      });
    }
  });
}
