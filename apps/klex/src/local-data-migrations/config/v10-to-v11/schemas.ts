import { configV11Schema } from './v11';
import { preservingSchema } from './validation';

export const configV11 = {
  version: 11,
  schema: preservingSchema((value) => configV11Schema.parse(value)),
};
