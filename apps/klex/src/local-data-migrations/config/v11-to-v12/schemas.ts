import { configV12Schema } from './v12';
import { preservingSchema } from './validation';

export const configV12 = {
  version: 12,
  schema: preservingSchema((value) => configV12Schema.parse(value)),
};
