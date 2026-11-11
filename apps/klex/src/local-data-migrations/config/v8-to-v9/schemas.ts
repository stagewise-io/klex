import { configV9Schema } from './v9';
import { preservingSchema } from './validation';

export const configV9 = {
  version: 9,
  schema: preservingSchema((value) => configV9Schema.parse(value)),
};
