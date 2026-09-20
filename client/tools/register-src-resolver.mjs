/** Installs `esm-src-resolver.mjs`; used via `node --import` from `npm test`. */

import { register } from 'node:module';

register('./esm-src-resolver.mjs', import.meta.url);
