// Helpers to register as a token holder, so the holder can later read data shared with all holders.
// They come from @odatano/contract-kit.
//
//   import { holderClaimKey, HOLDER_REGISTRY_CIRCUITS } from '@odatano/nightgate-tx/txbuilder';
//
//   const claimSecret = randomBytes(32).toString('hex');       // keep it
//   const claimKey = holderClaimKey(claimSecret);                // register this
//   await builder.buildSponsorable({ contractAddress: registry, calls: [{ circuit: 'registerHolder',
//       args: [{ nonce: freshNonceHex, color: tokenType, value: 1n }, claimKey] }] });
//   // ...sponsored; then ng.claimDisclosure({ payloadHash, tokenType, claimSecret })
//
// SPDX-License-Identifier: Apache-2.0
export { holderClaimKey, HOLDER_REGISTRY_CIRCUITS } from '@odatano/contract-kit';
