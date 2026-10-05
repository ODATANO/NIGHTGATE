export { deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from '@odatano/contract-kit';
/** Derives the token issuer secret from a wallet seed. A server session on the same seed gets the same issuer. */
export declare function tokenFactoryIssuerSecret(opts: { seedHex: string; accountIndex?: number }): Promise<string>;
