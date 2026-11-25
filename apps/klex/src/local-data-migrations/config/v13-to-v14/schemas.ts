import { configV14Schema } from './v14';
import { preservingSchema } from './validation';
export const configV14 = {
  version: 14,
  schema: preservingSchema((value) => configV14Schema.parse(value)),
};
