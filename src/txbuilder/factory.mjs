// Helpers to mint tokens with the token factory contract from your own process.
// Most helpers come from @odatano/contract-kit. This file adds the issuer secret derived from a seed.
//
//   import { createTxBuilder, tokenFactoryIssuerSecret, prepareMint, tokenTypeOf } from '@odatano/nightgate-tx/txbuilder';
//
//   const issuerSecret = await tokenFactoryIssuerSecret({ seedHex });        // hex; never leaves this process
//   const b = await createTxBuilder({ seedHex, package: '@odatano/contract-token-factory', walletSync: false, ... });
//   const { unboundTxB64 } = await b.buildSponsorable({ contractAddress: factory,
//       call: prepareMint({ name: 'CREDIT', amount: 1000n, recipientCoinPublicKey: b.shieldedKeys.coinPublicKey, issuerSecret }),
//       bind: false });
//   // ...sponsorUnboundTransaction(unboundTxB64, ...); the type: tokenTypeOf(pureCircuits, { issuerSecret, name, contractAddress })
//
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { deriveTokenFactoryIssuerSecret } from '@odatano/contract-kit';
export { deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from '@odatano/contract-kit';

const require = createRequire(import.meta.url);

/**
 * Derives the token issuer secret from a wallet seed, as hex.
 * A server session on the same seed gets the same issuer.
 */
export async function tokenFactoryIssuerSecret({ seedHex, accountIndex = 0 } = {}) {
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) throw new Error('tokenFactoryIssuerSecret: seedHex must be 128 hex chars (64-byte BIP39 seed)');
    const { zswap } = await require('../../srv/utils/wallet-hd.js').deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    return Buffer.from(deriveTokenFactoryIssuerSecret(zswap)).toString('hex');
}
