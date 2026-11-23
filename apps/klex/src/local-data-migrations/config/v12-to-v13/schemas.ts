import { configV13Schema } from './v13';
import { preservingSchema } from './validation';
export const configV13 = {
  version: 13,
  schema: preservingSchema((value) => configV13Schema.parse(value)),
};
