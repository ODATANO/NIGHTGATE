export { deriveTokenFactoryIssuerSecret, tokenName, nameOf, issuerKeyOf, domainOf, tokenTypeOf, prepareMint, prepareBurn, tokenFactoryWitnesses, TOKEN_FACTORY_CIRCUITS } from '@odatano/contract-kit';
/** The issuer secret of a seed (64 hex): the factory issuer rule over its zswap role seed; a server session on the same seed is the same issuer. */
export declare function tokenFactoryIssuerSecret(opts: { seedHex: string; accountIndex?: number }): Promise<string>;
