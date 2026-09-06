/**
 * Early bootstrap: apply the agent-token header mask BEFORE any other
 * Nightgate module loads. CAP's JSON formatter freezes its mask list on a
 * logger's first use, and importing `./index` already logs (a config warning
 * from `nightgate:config`, for example), so the mask has to be in place
 * before that import is even evaluated. Imported first by `cds-plugin.js`,
 * `src/plugin.ts` and `srv/server.ts`; it has no other effect.
 */
import cds from '@sap/cds';
import { applyLogHeaderMask } from './cap-log-mask';

applyLogHeaderMask(cds.env as { log?: Record<string, unknown> });
