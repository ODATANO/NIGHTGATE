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
    isTransportFailure, isAlreadyImported, waitLanded, sealTx, openTx
} from '@odatano/nightgate-tx/txbuilder';
import { prepareAttest } from '@odatano/nightgate-tx/calls';
import { Contract } from '@odatano/nightgate-tx/attestation-vault';
import { HDWallet, Roles } from '@midnightntwrk/wallet-sdk-hd';
import { WalletFacade, WalletEntrySchema, mergeWalletEntries } from '@midnightntwrk/wallet-sdk-facade';
import { InMemoryTransactionHistoryStorage } from '@midnightntwrk/wallet-sdk-abstractions';
import { ShieldedWallet } from '@midnightntwrk/wallet-sdk-shielded';
import { UnshieldedWallet, createKeystore, PublicKey } from '@midnightntwrk/wallet-sdk-unshielded-wallet';
import { DustWallet } from '@midnightntwrk/wallet-sdk-dust-wallet';
import { LedgerParameters } from '@midnightntwrk/ledger-v9';

const VAULT = process.env.VAULT;
const SEED_HEX = process.env.SEED_HEX;
const ZK_CONFIG_URL = process.env.ZK_CONFIG_URL;   // a public /zk-config/attestation-vault
const NETWORK = process.env.NETWORK || 'mainnet';
// Paying yourself needs a synced wallet, so an indexer you can reach (your own, or a hosted one with a key).
const INDEXER_HTTP = process.env.INDEXER_HTTP_URL;
const INDEXER_WS = process.env.INDEXER_WS_URL || (INDEXER_HTTP ? INDEXER_HTTP.replace(/^http/, 'ws') + '/ws' : undefined);
const NODE_URL = process.env.NODE_URL;
const file = process.argv[2];

if (!VAULT || !SEED_HEX || !ZK_CONFIG_URL || !INDEXER_HTTP || !NODE_URL || !file) {
    console.error('usage: VAULT=<addr> SEED_HEX=<128 hex> ZK_CONFIG_URL=<url> INDEXER_HTTP_URL=<url> NODE_URL=<url> node self-funded.mjs <file.json>');
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
const seeds = { shielded: roleSeed(Roles.Zswap), unshielded: roleSeed(Roles.NightExternal), dust: roleSeed(Roles.Dust) };
const keystore = createKeystore({ kind: 'schnorr', secret: seeds.unshielded }, NETWORK);
hd.hdWallet.clear();

const configuration = WalletFacade.resolveConfiguration({
    networkId: NETWORK,
    relayURL: new URL(NODE_URL),
    provers: { v9: { kind: 'wasm' } },
    indexerClientConnection: { indexerHttpUrl: INDEXER_HTTP, indexerWsUrl: INDEXER_WS },
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: { additionalFeeOverhead: 1n, feeBlocksMargin: 5 }
});
const facade = await WalletFacade.init({
    configuration,
    shielded: () => ShieldedWallet(configuration).startWithSeed(seeds.shielded),
    unshielded: () => UnshieldedWallet(configuration).startWithPublicKey(PublicKey.fromKeyStore(keystore)),
    dust: () => DustWallet(configuration).startWithSeed(seeds.dust, LedgerParameters.initialParameters().dust)
});
await facade.start(seeds);
// A fee proven against a stale dust root is rejected (1010/170), so the wallet syncs to the tip first.
console.log('syncing the fee wallet to the chain tip (a fresh seed syncs from genesis)...');
await facade.waitForSyncedState();

// 3. Pay the fee, submit, confirm. The wallet takes and returns transactions as sealed handles.
//    After a reject for good, revertTransaction frees the coins the fee reserved.
const tx = await deserializeTransaction(built.finalizedTxB64);
const recipe = await facade.balanceFinalizedTransaction(
    await sealTx('Finalized', tx, configuration.forks),
    { ttl: new Date(Date.now() + 30 * 60_000), tokenKindsToBalance: ['dust'] }
);
const handle = await facade.finalizeRecipe(recipe);
const finalized = await openTx(handle);
const identifier = txIdentifiers(finalized).at(-1);
console.log(`submitting ${identifier.slice(0, 16)}... to ${NODE_URL}`);
let landed;
for (let attempt = 0; !landed; attempt++) {
    try { await submitFinalized(finalized, { nodeUrl: NODE_URL }); break; }
    catch (e) {
        // 1013 Already Imported = the transaction is in the pool: go on to the confirmation.
        if (isAlreadyImported(e)) break;
        // Any other reject of a resend can mean the first send landed while the indexer lags,
        // so the identifier is looked up before the reject is trusted.
        landed = await waitLanded(identifier, { indexerHttpUrl: INDEXER_HTTP, timeoutMs: attempt > 0 ? 30_000 : 0 });
        if (landed) break;
        if (!isTransportFailure(e) || attempt >= 2) {
            await facade.revertTransaction(handle).catch(() => { /* the reject is the error to report */ });
            throw e;
        }
        await new Promise((r) => setTimeout(r, 5_000));
    }
}
landed ??= await waitLanded(identifier, { indexerHttpUrl: INDEXER_HTTP, timeoutMs: 240_000, pollMs: 6_000 });
if (!landed) throw new Error('not visible on the indexer yet; it may still land');

if (!landed.applied) {
    // In a block but the call failed: the fee was spent, rebuild against
    // current contract state.
    console.error(`landed in block ${landed.height} but NOT applied (${landed.status}); rebuild the call`);
    process.exit(1);
}
console.log(`anchored: block ${landed.height} (${landed.status})`);
await facade.stop();
process.exit(0);
