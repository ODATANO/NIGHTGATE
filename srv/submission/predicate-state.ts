/**
 * Crawler-free claim reader: recomputes claim keys (persistentHash of a tagged
 * struct embedding record key, anchored root and schema) byte-identical to the
 * circuit, so a claim resolves only while its anchor stands.
 */
import { hexToBytes } from '../utils/hex';
import { importArtifactByPath } from './contract-registry';

/** Type tags of the persistentHash structs (first struct member). */
export const CLAIM_TAG = {
    fieldPredicate: 16n,
    fieldEquality: 17n,
    fieldMembership: 18n,
    documentIntegrity: 19n,
    documentDiff: 20n,
    recordKey: 21n
} as const;

export interface PredicateLedger {
    /** claim_key -> valid_until (block time, seconds). */
    claims: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): bigint };
    /** record_key -> { root, schema }. Claim keys embed `root`. */
    content_anchors: { member(key: Uint8Array): boolean; lookup(key: Uint8Array): { root: Uint8Array; schema: Uint8Array } };
}

/** Claim kinds; all kinds share the `claims` map, separated by their tag. */
export type PredicateResultKind = 'field' | 'equality' | 'membership' | 'integrity' | 'diff';

export interface ReadPredicateResultDeps {
    contractAddress: string;
    claimKey: string;
    /** Informational; every kind lives in the same map. */
    kind?: PredicateResultKind;
    ledger: (state: any) => PredicateLedger;
    queryContractState: (contractAddress: string) => Promise<any | null>;
    /** A claim whose `valid_until` is not after this is absent. */
    nowSeconds?: number;
}

/** Whether an unexpired claim exists; null without contract state (clean negative, no 5xx). */
export async function readPredicateResult(
    deps: ReadPredicateResultDeps
): Promise<boolean | null> {
    const state = await deps.queryContractState(deps.contractAddress.toLowerCase());
    if (!state) return null;

    const led = deps.ledger(state.data ?? state);
    const key = hexToBytes(deps.claimKey);
    if (!led.claims.member(key)) return false;
    const now = BigInt(Math.floor(deps.nowSeconds ?? Date.now() / 1000));
    return led.claims.lookup(key) > now;
}

async function runtime(): Promise<any> {
    return import('@midnight-ntwrk/compact-runtime');
}

/** A struct type descriptor over ordered members, as the circuit hashes it. */
function structType(members: Array<[string, any]>) {
    return {
        alignment() {
            return members.map(([, t]) => t.alignment()).reduce((acc, a) => acc.concat(a));
        },
        toValue(v: any) {
            return members.map(([name, t]) => t.toValue(v[name])).reduce((acc, a) => acc.concat(a));
        }
    };
}

async function hashStruct(members: Array<[string, any]>, value: Record<string, unknown>): Promise<string> {
    const rt = await runtime();
    const digest: Uint8Array = rt.persistentHash(structType(members), value);
    return Buffer.from(digest).toString('hex');
}

async function scalarTypes() {
    const rt = await runtime();
    return {
        bytes32: new rt.CompactTypeBytes(32),
        u64: new rt.CompactTypeUnsignedInteger(18446744073709551615n, 8),
        u8: new rt.CompactTypeUnsignedInteger(255n, 1),
        rt
    };
}

/** persistentHash(AttestRecordKey{tag, owner, payload_hash}), as the `recordKey` pure circuit. */
export async function computeRecordKey(attesterId: string, payloadHash: string): Promise<string> {
    const { bytes32, u8 } = await scalarTypes();
    return hashStruct(
        [['tag', u8], ['owner', bytes32], ['payload_hash', bytes32]],
        { tag: CLAIM_TAG.recordKey, owner: hexToBytes(attesterId), payload_hash: hexToBytes(payloadHash) }
    );
}

/** `FieldPredicateClaim`: u8 tag, 4 x Bytes<32>, Uint<64> threshold, u8 op. */
export async function computeFieldPredicateClaimKey(
    recordKey: string,
    contentRoot: string,
    schemaId: string,
    fieldKey: string,
    threshold: bigint,
    op: number
): Promise<string> {
    const { bytes32, u64, u8 } = await scalarTypes();
    return hashStruct(
        [['tag', u8], ['record_key', bytes32], ['content_root', bytes32], ['schema_id', bytes32], ['field_key', bytes32], ['threshold', u64], ['op', u8]],
        { tag: CLAIM_TAG.fieldPredicate, record_key: hexToBytes(recordKey), content_root: hexToBytes(contentRoot), schema_id: hexToBytes(schemaId), field_key: hexToBytes(fieldKey), threshold, op: BigInt(op) }
    );
}

/** `FieldEqualityClaim`: u8 tag, 5 x Bytes<32>. */
export async function computeFieldEqualityClaimKey(
    recordKey: string,
    contentRoot: string,
    schemaId: string,
    fieldKey: string,
    expectedDigest: string
): Promise<string> {
    const { bytes32, u8 } = await scalarTypes();
    return hashStruct(
        [['tag', u8], ['record_key', bytes32], ['content_root', bytes32], ['schema_id', bytes32], ['field_key', bytes32], ['expected', bytes32]],
        { tag: CLAIM_TAG.fieldEquality, record_key: hexToBytes(recordKey), content_root: hexToBytes(contentRoot), schema_id: hexToBytes(schemaId), field_key: hexToBytes(fieldKey), expected: hexToBytes(expectedDigest) }
    );
}

/** `FieldMembershipClaim`: u8 tag, 5 x Bytes<32>. */
export async function computeFieldMembershipClaimKey(
    recordKey: string,
    contentRoot: string,
    schemaId: string,
    fieldKey: string,
    setRoot: string
): Promise<string> {
    const { bytes32, u8 } = await scalarTypes();
    return hashStruct(
        [['tag', u8], ['record_key', bytes32], ['content_root', bytes32], ['schema_id', bytes32], ['field_key', bytes32], ['set_root', bytes32]],
        { tag: CLAIM_TAG.fieldMembership, record_key: hexToBytes(recordKey), content_root: hexToBytes(contentRoot), schema_id: hexToBytes(schemaId), field_key: hexToBytes(fieldKey), set_root: hexToBytes(setRoot) }
    );
}

/** Bit i = slot i may differ. JS bitwise ops are exact to bit 31, so width <= 32. */
export function expandAllowedMask(mask: number, width: number = 16): boolean[] {
    const maxMask = width === 32 ? 0xffffffff : (1 << width) - 1;
    if (!Number.isInteger(mask) || mask < 0 || mask > maxMask) {
        throw new Error(`allowedMask must be an integer in 0..${maxMask}`);
    }
    return Array.from({ length: width }, (_, i) => (mask & (1 << i)) !== 0);
}

/** `DocumentIntegrityClaim`: u8 tag, 5 x Bytes<32>, Vector<width, Boolean> (width is part of the key). */
export async function computeDocumentIntegrityClaimKey(
    recordKeyA: string,
    contentRootA: string,
    recordKeyB: string,
    contentRootB: string,
    schemaId: string,
    allowedMask: number,
    width: number = 16
): Promise<string> {
    const { bytes32, u8, rt } = await scalarTypes();
    const mask = new rt.CompactTypeVector(width, rt.CompactTypeBoolean);
    return hashStruct(
        [['tag', u8], ['record_key_a', bytes32], ['content_root_a', bytes32], ['record_key_b', bytes32], ['content_root_b', bytes32], ['schema_id', bytes32], ['allowed_mask', mask]],
        {
            tag: CLAIM_TAG.documentIntegrity,
            record_key_a: hexToBytes(recordKeyA), content_root_a: hexToBytes(contentRootA),
            record_key_b: hexToBytes(recordKeyB), content_root_b: hexToBytes(contentRootB),
            schema_id: hexToBytes(schemaId),
            allowed_mask: expandAllowedMask(allowedMask, width)
        }
    );
}

/** `DocumentDiffClaim`: u8 tag, 5 x Bytes<32>, u8 k. */
export async function computeDocumentDiffClaimKey(
    recordKeyA: string,
    contentRootA: string,
    recordKeyB: string,
    contentRootB: string,
    schemaId: string,
    k: number
): Promise<string> {
    const { bytes32, u8 } = await scalarTypes();
    return hashStruct(
        [['tag', u8], ['record_key_a', bytes32], ['content_root_a', bytes32], ['record_key_b', bytes32], ['content_root_b', bytes32], ['schema_id', bytes32], ['k', u8]],
        {
            tag: CLAIM_TAG.documentDiff,
            record_key_a: hexToBytes(recordKeyA), content_root_a: hexToBytes(contentRootA),
            record_key_b: hexToBytes(recordKeyB), content_root_b: hexToBytes(contentRootB),
            schema_id: hexToBytes(schemaId),
            k: BigInt(k)
        }
    );
}

export function anchorOf(led: PredicateLedger, recordKey: string): { root: string; schema: string } | null {
    const key = hexToBytes(recordKey);
    if (!led.content_anchors.member(key)) return null;
    const a = led.content_anchors.lookup(key);
    return { root: Buffer.from(a.root).toString('hex'), schema: Buffer.from(a.schema).toString('hex') };
}

export function anchoredRootOf(led: PredicateLedger, recordKey: string): string | null {
    return anchorOf(led, recordKey)?.root ?? null;
}

export interface ReadPredicateStateForContractArgs {
    contractAddress: string;
    /** The attester whose record of `payloadHash` carries the claim. */
    attesterId: string;
    payloadHash: string;
    /** Numeric predicates only. */
    threshold?: bigint;
    op?: number;
    /** Required for the numeric and bytes kinds. */
    fieldKey?: string;
    expectedDigest?: string;
    setRoot?: string;
    /** Cross-root claims: document B. */
    payloadHashB?: string;
    /** Defaults to `attesterId`. */
    attesterIdB?: string;
    /** Integrity claim (with payloadHashB). */
    allowedMask?: number;
    /** Diff claim (with payloadHashB). */
    k?: number;
    /** Default 16; only the integrity claim key depends on it. */
    slotWidth?: number;
    artifactPath: string;
    contractProvidersConfig: import('../midnight/providers').ContractProvidersConfig;
    computeFieldClaimKey?: typeof computeFieldPredicateClaimKey;
    nowSeconds?: number;
}

/**
 * Recompute the claim key from the record's current anchor(s) and read it. A
 * claim made under a former anchor misses the map by construction.
 */
export async function readPredicateStateForContract(
    args: ReadPredicateStateForContractArgs
): Promise<boolean | null> {
    const { buildContractProviders } = await import('../midnight/providers.js');
    const bundle = await buildContractProviders(args.contractProvidersConfig);
    const artifact: any = await importArtifactByPath(args.artifactPath);

    const state = await bundle.publicDataProvider.queryContractState(args.contractAddress.toLowerCase());
    if (!state) return null;
    const led = artifact.ledger(state.data ?? state) as PredicateLedger;

    const recordKeyA = await computeRecordKey(args.attesterId, args.payloadHash);
    const anchorA = anchorOf(led, recordKeyA);
    if (anchorA === null) return false;

    const kind: PredicateResultKind = args.payloadHashB
        ? (args.allowedMask !== undefined ? 'integrity' : 'diff')
        : args.expectedDigest ? 'equality'
        : args.setRoot ? 'membership'
        : 'field';
    let claimKey: string;
    if (kind === 'integrity' || kind === 'diff') {
        const recordKeyB = await computeRecordKey(args.attesterIdB ?? args.attesterId, args.payloadHashB!);
        const anchorB = anchorOf(led, recordKeyB);
        if (anchorB === null) return false;
        // A comparison holds only under one shared schema.
        if (anchorA.schema !== anchorB.schema) return false;
        if (kind === 'integrity') {
            claimKey = await computeDocumentIntegrityClaimKey(recordKeyA, anchorA.root, recordKeyB, anchorB.root, anchorA.schema, args.allowedMask!, args.slotWidth ?? 16);
        } else {
            if (args.k === undefined) throw new Error('k is required for a document-diff claim');
            claimKey = await computeDocumentDiffClaimKey(recordKeyA, anchorA.root, recordKeyB, anchorB.root, anchorA.schema, args.k);
        }
    } else if (kind === 'equality') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a bytes-equality claim');
        claimKey = await computeFieldEqualityClaimKey(recordKeyA, anchorA.root, anchorA.schema, args.fieldKey, args.expectedDigest!);
    } else if (kind === 'membership') {
        if (!args.fieldKey) throw new Error('fieldKey is required for a set-membership claim');
        claimKey = await computeFieldMembershipClaimKey(recordKeyA, anchorA.root, anchorA.schema, args.fieldKey, args.setRoot!);
    } else {
        if (args.threshold === undefined || args.op === undefined) {
            throw new Error('threshold and op are required for a numeric predicate claim');
        }
        if (!args.fieldKey) throw new Error('fieldKey is required for a numeric predicate claim');
        claimKey = await (args.computeFieldClaimKey ?? computeFieldPredicateClaimKey)(
            recordKeyA, anchorA.root, anchorA.schema, args.fieldKey, args.threshold, args.op);
    }

    return readPredicateResult({
        contractAddress: args.contractAddress,
        claimKey,
        kind,
        ledger: artifact.ledger,
        queryContractState: async () => state,
        nowSeconds: args.nowSeconds
    });
}
