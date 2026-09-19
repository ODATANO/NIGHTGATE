/**
 * NIGHTGATE's lanes for `@odatano/cap-auth`: an agent token on the Nightgate
 * service (the grant hook authenticates it, also per `$batch` part) and the
 * optional public verify lane. Both pass under marker principals that own
 * nothing.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import { registerTransportLane, inLaneOf, markerUser, requestPath, setHeader, type TransportLane } from '@odatano/cap-auth';
import { AGENT_TOKEN_HEADER, AGENT_TOKEN_TRANSPORT_USER, PUBLIC_VERIFY_TRANSPORT_USER, PUBLIC_VERIFY_LANE_PREFIX } from './agent-token-transport';
import { configFlag } from './config';

export const AGENT_LANE_PREFIX = '/api/v1/nightgate';

export const agentTokenLane: TransportLane = {
    name: 'agent-token',
    match: (req) => {
        const token = req.headers?.[AGENT_TOKEN_HEADER];
        return typeof token === 'string' && token.length > 0 && inLaneOf(requestPath(req), AGENT_LANE_PREFIX);
    },
    authenticate: () => ({ user: markerUser(AGENT_TOKEN_TRANSPORT_USER) })
};

/** Any-origin CORS, only on the public verify lane; the verify service rate-limits by address. */
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

/** Registers both lanes; runs at plugin load. Never throws (a plugin must not take the host down). */
export function registerNightgateTransportLanes(): void {
    try {
        registerTransportLane(agentTokenLane);
        registerTransportLane(publicVerifyLane);
    } catch (err) {
        cds.log('nightgate').error(`transport lanes not registered: ${err instanceof Error ? err.message : String(err)}`);
    }
}
