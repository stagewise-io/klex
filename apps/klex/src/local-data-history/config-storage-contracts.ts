import { z } from 'zod';

import {
  parseLegacyKlexConfig,
  parseStoredKlexConfig,
  parseStoredKlexConfigV2,
  parseStoredKlexConfigV4,
  parseStoredKlexConfigV5,
  parseStoredKlexConfigV6,
} from './config-contracts';

function preservingSchema(
  validate: (value: Record<string, unknown>) => void,
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

export const configSchema1 = {
  version: 1,
  schema: preservingSchema((value) => {
    if (value.configVersion === 2) {
      parseStoredKlexConfigV2(value);
      return;
    }
    parseLegacyKlexConfig(value);
  }),
};
export const configSchema2 = {
  version: 2,
  schema: preservingSchema(parseStoredKlexConfigV2),
};
export const configSchema3 = {
  version: 3,
  schema: preservingSchema(parseStoredKlexConfigV2),
};
export const configSchema4 = {
  version: 4,
  schema: preservingSchema(parseStoredKlexConfigV4),
};
export const configSchema5 = {
  version: 5,
  schema: preservingSchema(parseStoredKlexConfigV5),
};
export const configSchema6 = {
  version: 6,
  schema: preservingSchema(parseStoredKlexConfigV6),
};
export const configSchema7 = {
  version: 7,
  schema: preservingSchema(parseStoredKlexConfig),
};
