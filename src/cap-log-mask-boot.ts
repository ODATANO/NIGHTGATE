// Hides the agent token header in logs. Import this before any other module of this package.
// CAP fixes its list of hidden headers on the first log line, and loading `./index` can already log.
import cds from '@sap/cds';
import { applyLogHeaderMask } from './cap-log-mask';

applyLogHeaderMask(cds.env as { log?: Record<string, unknown> });
