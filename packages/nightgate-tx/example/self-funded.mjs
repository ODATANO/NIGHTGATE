// Anchor a document on Midnight WITHOUT a sponsor: build and prove locally,
// pay the dust fee from your own wallet, submit to the public node yourself,
// confirm by transaction identifier. Needs @polkadot/api next to this package
// (optional peer dependency, used to encode the extrinsic).
//
//   npm install @odatano/nightgate-tx @polkadot/api
//   VAULT=... SEED_HEX=... ZK_CONFIG_URL=... node self-funded.mjs ./mydoc.json
//
// The wallet behind SEED_HEX must hold NIGHT registered for dust generation
// and have dust available; see the NIGHTGATE docs on dust registration.
//
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createTxBuilder } from '@odatano/nightgate-tx';
import {
    deserializeTransaction, txIdentifiers, submitFinalized,
    isTransportFailure, isAlreadyImported, waitLanded, withDustGuard
} from '@odatano/nightgate-tx/txbuilder';
import { prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { WalletFacade, WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk-facade';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { makeWasmProvingService } from '@midnightntwrk/wallet-sdk-capabilities/proving';
import { ZswapSecretKeys, DustSecretKey, LedgerParameters } from '@midnight-ntwrk/ledger-v8';

const VAULT = process.env.VAULT;
const SEED_HEX = process.env.SEED_HEX;
const ZK_CONFIG_URL = process.env.ZK_CONFIG_URL;   // a public /zk-config/attestation-vault
const NETWORK = process.env.NETWORK || 'preprod';
const INDEXER_HTTP = process.env.INDEXER_HTTP_URL || `https://indexer.${NETWORK}.midnight.network/api/v4/graphql`;
const INDEXER_WS = process.env.INDEXER_WS_URL || INDEXER_HTTP.replace(/^http/, 'ws') + '/ws';
const NODE_URL = process.env.NODE_URL || `wss://rpc.${NETWORK}.midnight.network/`;
const file = process.argv[2];

if (!VAULT || !SEED_HEX || !ZK_CONFIG_URL || !file) {
    console.error('usage: VAULT=<addr> SEED_HEX=<128 hex> ZK_CONFIG_URL=<url> node self-funded.mjs <file.json>');
    process.exit(2);
}

// 1. Build, prove and sign the contract call locally (no wallet state needed:
//    vault calls move no value, so walletSync stays off).
const document = await readFile(file);
const payloadHash = createHash('sha256').update(document).digest('hex');
const metadataHash = createHash('sha256').update(JSON.stringify({ file, at: new Date().toISOString() })).digest('hex');

const builder = await createTxBuilder({
    seedHex: SEED_HEX, networkId: NETWORK,
    indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS, nodeUrl: NODE_URL,
    zkConfigBaseUrl: ZK_CONFIG_URL, contractClass: Contract,
    circuits: ['attest'], walletSync: false
});
console.log(`attester id ${builder.attesterId}`);
const call = prepareAttest({ payloadHash, metadataHash, attestationSecret: builder.attestationSecret });
const built = await builder.buildSponsorable({ contractAddress: VAULT, call });
await builder.close();
console.log(`built + proven locally (${built.serializedBytes} bytes)`);

// 2. A wallet facade for the fee: same seed, same derivation the builder uses.
const hd = HDWallet.fromSeed(new Uint8Array(Buffer.from(SEED_HEX, 'hex')));
const account = hd.hdWallet.selectAccount(0);
const roleSeed = (r) => account.selectRole(r).deriveKeyAt(0).key;
const zswapKeys = ZswapSecretKeys.fromSeed(roleSeed(Roles.Zswap));
const dustKey = DustSecretKey.fromSeed(roleSeed(Roles.Dust));
const keystore = createKeystore(roleSeed(Roles.NightExternal), NETWORK);
hd.hdWallet.clear();

const configuration = {
    networkId: NETWORK,
    relayURL: new URL(NODE_URL),
    provingServerUrl: new URL('http://127.0.0.1:6300'),   // unused: wasm proving
    indexerClientConnection: { indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
};
const facade = await WalletFacade.init({
    configuration,
    provingService: () => makeWasmProvingService({}),
    shielded: () => ShieldedWallet(configuration).startWithSecretKeys(zswapKeys),
    unshielded: () => UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: () => DustWallet(configuration).startWithSecretKey(dustKey, LedgerParameters.initialParameters().dust)
});
await facade.start(zswapKeys, dustKey);
// A fee proven against a stale dust root is rejected (1010/170). A long-lived
// runner should gate on real dust progress before every balance; for a
// one-shot script the SDK's own synced-state wait does.
console.log('syncing the fee wallet to the chain tip (a fresh seed syncs from genesis)...');
await facade.waitForSyncedState();

// 3. Pay the fee, submit, confirm; the dust guard restores the wallet if the
//    node rejects the transaction before it reaches the mempool.
const tx = await deserializeTransaction(built.finalizedTxB64);
const landed = await withDustGuard(facade, { configuration, dustKey }, async () => {
    const recipe = await facade.balanceFinalizedTransaction(
        tx, { shieldedSecretKeys: zswapKeys, dustSecretKey: dustKey },
        { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: ['dust'] }
    );
    const finalized = await facade.finalizeRecipe(recipe);
    const identifier = txIdentifiers(finalized).at(-1);
    console.log(`submitting ${identifier.slice(0, 16)}... to ${NODE_URL}`);
    for (let attempt = 0; ; attempt++) {
        try { await submitFinalized(finalized, { nodeUrl: NODE_URL }); break; }
        catch (e) {
            // 1013 Already Imported = the transaction IS in the pool: go
            // straight to the confirmation loop.
            if (isAlreadyImported(e)) break;
            // ANY other reject of a RESEND can mean the first send landed
            // (e.g. a 1010 whose note it already spent) while the indexer
            // still lags: wait for the identifier before trusting the
            // reject. A first-send reject gets one immediate probe.
            const found = await waitLanded(identifier, { indexerHttpUrl: INDEXER_HTTP, timeoutMs: attempt > 0 ? 30_000 : 0 });
            if (found) return found;
            if (!isTransportFailure(e) || attempt >= 2) throw e;
            await new Promise((r) => setTimeout(r, 5_000));
        }
    }
    const found = await waitLanded(identifier, { indexerHttpUrl: INDEXER_HTTP, timeoutMs: 240_000, pollMs: 6_000 });
    if (found) return found;
    throw new Error('not visible on the indexer yet; it may still land');
});

if (!landed.applied) {
    // In a block but the call failed: the fee was spent, rebuild against
    // current contract state.
    console.error(`landed in block ${landed.height} but NOT applied (${landed.status}); rebuild the call`);
    process.exit(1);
}
console.log(`anchored: block ${landed.height} (${landed.status})`);
await facade.stop();
process.exit(0);
