import { configV2Schema } from './v2';
import { configV3Schema } from './v3';
import { preservingSchema } from './validation';

export const configV2 = {
  version: 2,
  schema: preservingSchema((value) => configV2Schema.parse(value)),
};
export const configV3 = {
  version: 3,
  schema: preservingSchema((value) => configV3Schema.parse(value)),
};
