// Two extra login routes for `@odatano/cap-auth`. One accepts agent tokens, the other opens the optional public verify service.
// Both pass the request on as a placeholder user that owns nothing. The agent grant check verifies the token later.
// SPDX-License-Identifier: Apache-2.0

import cds from '@sap/cds';
import { registerTransportLane, inLaneOf, markerUser, requestPath, setHeader, type TransportLane } from '@odatano/cap-auth';
import { AGENT_TOKEN_HEADER, AGENT_TOKEN_TRANSPORT_USER, PUBLIC_VERIFY_TRANSPORT_USER, PUBLIC_VERIFY_LANE_PREFIX } from './agent-token-transport';
import { configFlag } from './config';
import { errorMessage } from './errors';

export const AGENT_LANE_PREFIX = '/odata/v4/midnight';

export const agentTokenLane: TransportLane = {
    name: 'agent-token',
    match: (req) => {
        const token = req.headers?.[AGENT_TOKEN_HEADER];
        return typeof token === 'string' && token.length > 0 && inLaneOf(requestPath(req), AGENT_LANE_PREFIX);
    },
    authenticate: () => ({ user: markerUser(AGENT_TOKEN_TRANSPORT_USER) })
};

/** Allows requests from any web origin, only for the public verify service. That service rate-limits by client address. */
export const publicVerifyLane: TransportLane = {
    name: 'public-verify',
    match: (req) => configFlag('NIGHTGATE_PUBLIC_VERIFY') && inLaneOf(requestPath(req), PUBLIC_VERIFY_LANE_PREFIX),
    authenticate: (req, res) => {
        setHeader(res, 'Access-Control-Allow-Origin', '*');
        setHeader(res, 'Access-Control-Allow-Methods', 'GET, OPTIONS');
        setHeader(res, 'Access-Control-Allow-Headers', 'accept, content-type');
        setHeader(res, 'Access-Control-Max-Age', '600');
        if (String(req.method).toUpperCase() === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return { handled: true };
        }
        return { user: markerUser(PUBLIC_VERIFY_TRANSPORT_USER) };
    }
};

/** Registers both lanes at plugin load. Never throws, so a failure cannot crash the host app. */
export function registerNightgateTransportLanes(): void {
    try {
        registerTransportLane(agentTokenLane);
        registerTransportLane(publicVerifyLane);
    } catch (err) {
        cds.log('nightgate').error(`transport lanes not registered: ${errorMessage(err)}`);
    }
}
