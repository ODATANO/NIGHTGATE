// Must stay the first import. It hides the agent token in logs, and the modules below may already log.
import '../src/cap-log-mask-boot';
import http from 'node:http';
import cds from '@sap/cds';
import type { Application, ErrorRequestHandler } from 'express';

import { initialize, shutdown, SchemaNotDeployedError } from '../src/index';
import { mountZkConfigRoute, mountContractManifestRoute } from '../src/connector-routes';
import { registerNightgateTransportLanes } from './utils/transport-lanes';
import { NightgateError, errorMessage } from './utils/errors';
import { redactInvalidJson } from './utils/http-errors';
import { openAuthKind, openAuthRefusal } from './utils/runtime-topology';
import { configNumber } from './utils/config';

const log = cds.log('nightgate');

registerNightgateTransportLanes();

const LOOPBACK = '127.0.0.1';

// CAP refuses a `$batch` with more requests. An explicit `cds.odata.batch_limit` stays.
const odata = cds.env.odata as { batch_limit?: number };
odata.batch_limit ??= configNumber('NIGHTGATE_BATCH_MAX_PARTS');

// Runs before CAP's own handler, which logs the error of every refused request. The CAP types leave out `after`.
(cds.middlewares as typeof cds.middlewares & { after: ErrorRequestHandler[] }).after.unshift(redactInvalidJson);

cds.on('bootstrap', (app: Application) => {
    // Thrown here, the server never listens. With such an auth kind every service would answer every caller as an admin.
    const refusal = openAuthRefusal();
    if (refusal) throw new NightgateError('RUNTIME_TOPOLOGY_UNSUPPORTED', refusal);
    // CAP listens on every address and has no setting for it. A server that checks no credentials answers this machine only.
    const open = openAuthKind();
    if (open) {
        app.listen = ((port: number) => http.createServer(app).listen(port, LOOPBACK)) as typeof app.listen;
        log.warn(`authentication kind '${open}' checks no credentials, so the server listens on ${LOOPBACK} only; configure basic or JWT auth to reach it from another machine`);
    }
    // Without this every caller behind a reverse proxy has the proxy's address.
    const hops = configNumber('NIGHTGATE_TRUST_PROXY');
    if (hops > 0) {
        app.set('trust proxy', hops);
        log.info(`the caller address is read from X-Forwarded-For behind ${hops} trusted prox${hops === 1 ? 'y' : 'ies'}`);
    }
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
