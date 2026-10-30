// Checks that a WalletFacade can be built against the real SDK. It skips start(), so no running services are needed.
// Run: node scripts/integration-test-wallet-facade.mjs

import { randomBytes } from 'node:crypto';
import { WalletFacade } from '@midnightntwrk/wallet-sdk-facade';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, PublicKey, createKeystore } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { InMemoryTransactionHistoryStorage, NetworkId } from '@midnightntwrk/wallet-sdk-abstractions';
import { ZswapSecretKeys, DustSecretKey } from '@midnight-ntwrk/ledger-v8';

const seed = randomBytes(32);
const zswapKeys = ZswapSecretKeys.fromSeed(new Uint8Array(seed));
const dustKey   = DustSecretKey.fromSeed(new Uint8Array(seed));

console.log('OK   keys derived');
console.log('     coinPublicKey:', zswapKeys.coinPublicKey.slice(0, 24) + '...');

// Probe configuration, preprod URLs (won't connect during init).
const configuration = {
    networkId: NetworkId.PreProd,
    provingServerUrl: new URL('http://localhost:6300'),
    relayURL: new URL(process.env.NIGHTGATE_NODE_URL || 'ws://127.0.0.1:9944'),
    indexerClientConnection: {
        indexerHttpUrl: process.env.NIGHTGATE_INDEXER_HTTP_URL || 'http://127.0.0.1:8088/api/v4/graphql',
        indexerWsUrl:   process.env.NIGHTGATE_INDEXER_WS_URL || 'ws://127.0.0.1:8088/api/v4/graphql/ws'
    },
    txHistoryStorage: new InMemoryTransactionHistoryStorage()
};

console.log('OK   configuration built');

try {
    const facade = await WalletFacade.init({
        configuration,
        shielded:   (cfg) => ShieldedWallet(cfg).startWithSecretKeys(zswapKeys),
        unshielded: (cfg) => UnshieldedWallet(cfg).startWithPublicKey(
            PublicKey.fromKeyStore(createKeystore(new Uint8Array(seed), cfg.networkId))
        ),
        dust:       (cfg) => DustWallet(cfg)
    });
    console.log('OK   WalletFacade.init() completed');
    console.log('     facade has methods:', Object.keys(facade).filter(k => !k.startsWith('_')).slice(0, 8).join(', '));
    console.log('     shielded:',  typeof facade.shielded);
    console.log('     unshielded:', typeof facade.unshielded);
    console.log('     dust:',       typeof facade.dust);
    console.log();
    console.log('Construction works. facade.start() not called: needs running indexer + proof server + funded keys.');
    process.exit(0);
} catch (err) {
    console.error('FAIL WalletFacade.init():', err.message);
    if (err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'));
    process.exit(1);
}
