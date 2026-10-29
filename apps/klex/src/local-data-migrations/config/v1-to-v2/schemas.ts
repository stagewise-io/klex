import { configV1Schema } from './v1';
import { configV2Schema } from './v2';
import { preservingSchema } from './validation';

// Unversioned agents could already have public configVersion 2.
export const configV1 = {
  version: 1,
  schema: preservingSchema((value) =>
    value.configVersion === 2
      ? configV2Schema.parse(value)
      : configV1Schema.parse(value),
  ),
};
export const configV2 = {
  version: 2,
  schema: preservingSchema((value) => configV2Schema.parse(value)),
};
