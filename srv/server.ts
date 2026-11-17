// Must stay the first import. It hides the agent token in logs, and the modules below may already log.
import '../src/cap-log-mask-boot';
import cds from '@sap/cds';
import type { Application } from 'express';

import { initialize, shutdown, SchemaNotDeployedError } from '../src/index';
import { mountZkConfigRoute, mountContractManifestRoute } from '../src/connector-routes';
import { applyPoolDefault } from '../src/cap-pool-default';
import { registerNightgateTransportLanes } from './utils/transport-lanes';
import { errorMessage } from './utils/errors';

const log = cds.log('nightgate');

// Must run before CAP's database layer loads. See cap-pool-default.ts.
if (applyPoolDefault(cds.env as { features?: Record<string, unknown> })) {
    log.info('features.use_generic_pool defaulted to true (the built-in @cap-js/db-service pool loses connections on acquire timeouts); set it explicitly in the config to override');
}

registerNightgateTransportLanes();

cds.on('bootstrap', (app: Application) => {
    mountZkConfigRoute(app);
    mountContractManifestRoute(app);
});

cds.on('served', async () => {
    if (process.env.SKIP_AUTO_INIT === 'true') return;
    try {
        await initialize();
    } catch (err) {
        // The server keeps running while NIGHTGATE is offline, so getReadiness() can report it.
        if (err instanceof SchemaNotDeployedError) {
            log.error(`Nightgate remains offline because its schema is not deployed. ${err.message}`);
            return;
        }
        log.error(`initialize() failed: ${errorMessage(err)}`);
    }
});

cds.on('shutdown', async () => {
    await shutdown();
});
