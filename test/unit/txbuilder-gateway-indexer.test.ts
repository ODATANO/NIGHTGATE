/** The gateway's indexer lane as `gatewayIndexerUrls` derives it from `connect()` options (`src/txbuilder/api-provider.mjs`). */

import { describe, it, expect } from 'vitest';

const importProvider = () => import('../../src/txbuilder/api-provider.mjs' as string);

const KEY = 'oda_' + 'ab'.repeat(20);

describe('gatewayIndexerUrls', () => {
    it('builds the lane URLs for a gateway key, the key in the query string', async () => {
        const { gatewayIndexerUrls } = await importProvider();
        expect(gatewayIndexerUrls({ baseUrl: 'https://api.preprod.odatano.dev/', token: KEY })).toEqual({
            indexerHttpUrl: `https://api.preprod.odatano.dev/indexer/api/v4/graphql?key=${KEY}`,
            indexerWsUrl: `wss://api.preprod.odatano.dev/indexer/api/v4/graphql/ws?key=${KEY}`
        });
        expect(gatewayIndexerUrls({ baseUrl: 'http://localhost:4030', token: KEY })?.indexerWsUrl).toBe(`ws://localhost:4030/indexer/api/v4/graphql/ws?key=${KEY}`);
    });

    it('answers null for anything but a gateway key', async () => {
        const { gatewayIndexerUrls } = await importProvider();
        expect(gatewayIndexerUrls({ baseUrl: 'https://x', agentToken: 'ngat_' + 'a'.repeat(40) })).toBeNull();
        expect(gatewayIndexerUrls({ baseUrl: 'https://x', token: 'oda_short' })).toBeNull();
        expect(gatewayIndexerUrls({ baseUrl: 'https://x', username: 'nightgate', password: 'pw' })).toBeNull();
        expect(gatewayIndexerUrls(undefined)).toBeNull();
        expect(gatewayIndexerUrls({ token: KEY })).toBeNull();
    });
});
