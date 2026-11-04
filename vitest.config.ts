import { defineConfig } from 'vitest/config';

import { staticMascots } from './apps/website/static-mascot-plugin.ts';

export default defineConfig({ plugins: [staticMascots()] });
