import { configV6Schema } from './v6';
import { configV7Schema } from './v7';
import { preservingSchema } from './validation';

export const configV6 = {
  version: 6,
  schema: preservingSchema((value) => configV6Schema.parse(value)),
};
export const configV7 = {
  version: 7,
  schema: preservingSchema((value) => configV7Schema.parse(value)),
};
