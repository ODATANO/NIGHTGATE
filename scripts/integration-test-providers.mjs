// Integration check: real Midnight SDK is callable with the shapes that
// srv/midnight/providers.ts expects. Does NOT make any network calls; just
// constructs providers and verifies the SDK functions accept our arg shapes.
//
// Run: node scripts/integration-test-providers.mjs

import WebSocket from 'ws';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider }   from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider }      from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { levelPrivateStateProvider } from '@midnight-ntwrk/midnight-js-level-private-state-provider';
import path from 'node:path';
import os from 'node:os';

let failures = 0;
function ok(name, value) {
    if (value === undefined || value === null) {
        console.error(`FAIL ${name}: undefined/null`);
        failures++;
    } else {
        console.log(`OK   ${name}`);
    }
}

// 1. zkConfigProvider, constructor takes a directory string
const zkConfigProvider = new NodeZkConfigProvider('/tmp/managed/test');
ok('NodeZkConfigProvider construct', zkConfigProvider);
ok('NodeZkConfigProvider.directory', zkConfigProvider.directory);

// 2. publicDataProvider, (httpUrl, wsUrl, optionalWsImpl)
const publicDataProvider = indexerPublicDataProvider(
    'https://indexer.preprod.midnight.network/api/v4/graphql',
    'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
    WebSocket
);
ok('indexerPublicDataProvider', publicDataProvider);

// 3. proofProvider, (url, zkConfigProvider)
const proofProvider = httpClientProofProvider('http://localhost:6300', zkConfigProvider);
ok('httpClientProofProvider', proofProvider);

// 4. levelPrivateStateProvider, { accountId, privateStoragePasswordProvider }
//    May open a LevelDB in the cwd; that's fine for a one-shot script.
try {
    const privateStateProvider = levelPrivateStateProvider({
        accountId: 'integration-test-account',
        privateStoragePasswordProvider: async () => 'integration-test-passphrase-16+chars'
    });
    ok('levelPrivateStateProvider', privateStateProvider);
    ok('levelPrivateStateProvider.invalidateEncryptionCache', privateStateProvider.invalidateEncryptionCache);
} catch (err) {
    console.error(`FAIL levelPrivateStateProvider: ${err.message.split('\n')[0]}`);
    failures++;
}

console.log();
if (failures === 0) {
    console.log('All provider constructors accept the shapes srv/midnight/providers.ts uses.');
    process.exit(0);
} else {
    console.error(`${failures} integration check(s) failed.`);
    process.exit(1);
}
