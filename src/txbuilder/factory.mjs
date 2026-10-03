// Token factory, the caller's side. The issuer rule, names, types and the
// call inputs live in @odatano/contract-kit; this adds the seed-level entry.
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
 * The issuer secret of a seed (64 hex): the kit's rule over the seed's zswap
 * role seed, so a session on the same seed is the same issuer on the server.
 */
export async function tokenFactoryIssuerSecret({ seedHex, accountIndex = 0 } = {}) {
    if (!/^[0-9a-fA-F]{128}$/.test(String(seedHex ?? ''))) throw new Error('tokenFactoryIssuerSecret: seedHex must be 128 hex chars (64-byte BIP39 seed)');
    const { zswap } = await require('../../srv/utils/wallet-hd.js').deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    return Buffer.from(deriveTokenFactoryIssuerSecret(zswap)).toString('hex');
}
