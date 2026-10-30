// Helpers to mint tokens with the token factory contract from your own process.
// Adds the issuer secret derived from a seed to the helpers of @odatano/contract-kit.
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { deriveTokenFactoryIssuerSecret } from '@odatano/contract-kit';
export { deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from '@odatano/contract-kit';

const require = createRequire(import.meta.url);
const { assertSeedHex } = require('../../srv/utils/hex-patterns.js');

/** Derives the token issuer secret as hex from a wallet seed. A server session on the same seed gets the same issuer. */
export async function tokenFactoryIssuerSecret({ seedHex, accountIndex = 0 } = {}) {
    assertSeedHex(seedHex, 'tokenFactoryIssuerSecret');
    const { zswap } = await require('../../srv/utils/wallet-hd.js').deriveRoleSeeds(new Uint8Array(Buffer.from(seedHex, 'hex')), accountIndex);
    return Buffer.from(deriveTokenFactoryIssuerSecret(zswap)).toString('hex');
}
