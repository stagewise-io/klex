import { configV3Schema } from './v3';
import { configV4Schema } from './v4';
import { preservingSchema } from './validation';

export const configV3 = {
  version: 3,
  schema: preservingSchema((value) => configV3Schema.parse(value)),
};
export const configV4 = {
  version: 4,
  schema: preservingSchema((value) => configV4Schema.parse(value)),
};
