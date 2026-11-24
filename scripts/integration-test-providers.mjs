// Checks that the Midnight SDK provider factories accept the argument shapes srv/midnight/providers.ts uses. No network calls.
// Run: node scripts/integration-test-providers.mjs

import WebSocket from 'ws';
import { indexerPublicDataProvider } from '@midnight-ntwrk/midnight-js-indexer-public-data-provider';
import { httpClientProofProvider }   from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { NodeZkConfigProvider }      from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const { deriveIndexerWsUrl } = createRequire(import.meta.url)('../srv/utils/indexer-url.js');

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

// 2. publicDataProvider, (httpUrl, wsUrl, optionalWsImpl); nothing is dialed here, so any well-formed URL does
const indexerHttpUrl = process.env.NIGHTGATE_INDEXER_HTTP_URL || 'http://127.0.0.1:8088/api/v4/graphql';
const publicDataProvider = indexerPublicDataProvider(
    indexerHttpUrl,
    process.env.NIGHTGATE_INDEXER_WS_URL || deriveIndexerWsUrl(indexerHttpUrl),
    WebSocket
);
ok('indexerPublicDataProvider', publicDataProvider);

// 3. proofProvider, (url, zkConfigProvider)
const proofProvider = httpClientProofProvider('http://localhost:6300', zkConfigProvider);
ok('httpClientProofProvider', proofProvider);

console.log();
if (failures === 0) {
    console.log('All provider constructors accept the shapes srv/midnight/providers.ts uses.');
    process.exit(0);
} else {
    console.error(`${failures} integration check(s) failed.`);
    process.exit(1);
}
