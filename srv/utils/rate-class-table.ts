// The rate classes: every rate-limited call belongs to one, named by the resource it protects.
// A class has a fixed window and one count, from its env key or the sponsor policy file.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const RATE_CLASS_NAMES = ['prove', 'deploy', 'sponsor', 'compute', 'read', 'wallet', 'signing', 'admin', 'public-verify'] as const;
export type RateClass = typeof RATE_CLASS_NAMES[number];

export interface RateClassSpec {
    windowMs: number;
    /** The config key that holds the count; its default is in the config table. */
    envKey: string;
    /** Tracked keys before the least recently used one is dropped. */
    maxKeys?: number;
    /** Listed in `getGrantUsage.limits.classes`, because a token can reach the class. */
    grantVisible: boolean;
    doc: string;
}

export const RATE_CLASSES: Readonly<Record<RateClass, RateClassSpec>> = {
    prove: { windowMs: HOUR, envKey: 'NIGHTGATE_PROVE_RATE_LIMIT', grantVisible: true, doc: 'calls that prove and submit on the caller\'s session: contract calls and batches, token operations, the issue* attestations, anchoring, document registry, disclosure, buildSponsorable; per session' },
    deploy: { windowMs: HOUR, envKey: 'NIGHTGATE_DEPLOY_RATE_LIMIT', grantVisible: true, doc: '`deployContract`; per session' },
    sponsor: { windowMs: HOUR, envKey: 'NIGHTGATE_SPONSOR_RATE_LIMIT', grantVisible: true, doc: 'calls the pool or a pinned sponsor pays for: `sponsorFinalizedTransaction`, `sponsorUnboundTransaction`, `sponsorSwap`, `mintFactoryToken`; per principal' },
    compute: { windowMs: HOUR, envKey: 'NIGHTGATE_COMPUTE_RATE_LIMIT', grantVisible: true, doc: 'calls that compute or write on the server without a transaction: `prepareDocumentProof`, `prepareMembershipSet`, `claimDisclosure`, `grantDisclosureToHolders`, `revokeHolderDisclosure`, `postSwapOffer`, `retireSwapOffer`, `reindexDisclosures` (per contract); per principal' },
    read: { windowMs: MINUTE, envKey: 'NIGHTGATE_READ_RATE_LIMIT', grantVisible: true, doc: 'read functions: the offer board, `getBoardStatus`, `verifyDocument`, `verifyPredicateAttestation`, `getRuntimeInfo`, wallet balance, sync progress, sponsor pool status, fee estimate; per principal' },
    wallet: { windowMs: MINUTE, envKey: 'NIGHTGATE_WALLET_RATE_LIMIT', grantVisible: false, doc: 'wallet lifecycle: `connectWallet`, `sendNight`, dust registration; per principal, never grantable' },
    signing: { windowMs: HOUR, envKey: 'NIGHTGATE_SIGNING_KEY_RATE_LIMIT', grantVisible: false, doc: '`connectWalletForSigning` and `deriveWalletInfo`: a guard against guessing mnemonics; per principal' },
    admin: { windowMs: HOUR, envKey: 'NIGHTGATE_ADMIN_RATE_LIMIT', grantVisible: false, doc: 'grant administration: create, update, rotate, revoke; per principal' },
    'public-verify': { windowMs: MINUTE, envKey: 'NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT', maxKeys: 20000, grantVisible: false, doc: 'the credential-free verify service; per client address' }
};

export function isRateClass(value: unknown): value is RateClass {
    return typeof value === 'string' && (RATE_CLASS_NAMES as readonly string[]).includes(value);
}

/** A window as a word: `minute`, `hour` or `day`, else the seconds. */
export function describeWindow(windowMs: number): string {
    if (windowMs === HOUR) return 'hour';
    if (windowMs === MINUTE) return 'minute';
    if (windowMs === 24 * HOUR) return 'day';
    return `${Math.round(windowMs / 1000)} s`;
}
