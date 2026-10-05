/**
 * Hides the agent token header in logs. Must be imported before any other module of this package.
 * CAP fixes its list of hidden headers when it logs the first line, and loading `./index` can already log.
 */
import cds from '@sap/cds';
import { applyLogHeaderMask } from './cap-log-mask';

applyLogHeaderMask(cds.env as { log?: Record<string, unknown> });
