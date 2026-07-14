/**
 * Vitest global setup (runs before every test file).
 *
 * Mirrors the ODATANO core harness:
 *  - NO_TELEMETRY: stop the telemetry cds-plugin from loading.
 *  - SKIP_AUTO_INIT: the cds.test() server still serves all OData services, but
 *    src/plugin.ts skips initialize() (crawler + wallet worker thread) so tests
 *    run against the in-memory DB without live side-effects.
 *  - cds.User.default = Privileged: service-level @requires (e.g. 'admin') pass
 *    without supplying auth headers on every request.
 *
 * Unit suites that mock '@sap/cds' are unaffected — they replace the module
 * wholesale, so the cds.User assignment below simply no-ops for them.
 */
process.env.NO_TELEMETRY = 'true';
process.env.SKIP_AUTO_INIT = 'true';

import cds from '@sap/cds';

if (cds.User && (cds.User as any).Privileged) {
    cds.User.default = (cds.User as any).Privileged as unknown as typeof cds.User.default;
}
