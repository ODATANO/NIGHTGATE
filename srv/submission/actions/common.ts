// Shared helpers, command types and rate limits for the submission handlers.
// SPDX-License-Identifier: Apache-2.0
import cds from '@sap/cds';
import { Documents, PredicateAttestations, Transactions, TransactionResults, type Transaction, type TransactionResult } from '#cds-models/midnight';
import { getArtifactGenerationDigest } from '../contract-registry';
import { resolveNightgateRuntimeConfig, getNightgatePluginConfig, mainnetSubmissionBlockReason } from '../../utils/nightgate-config';
import { WorkflowReconciliationRequiredError, type StartJobResult } from '../background-jobs';
import { UINT64_MAX } from '../verify-state';
import { effectiveSponsorPolicy, getGlobalSponsorPolicy, type SponsorPolicy } from '../sponsor-policy';
import { currentGrantPolicy, consumeValueBudget } from '../../sessions/agent-grants';

import { configInt } from '../../utils/config';
import type { DbRunner, TxCapableDb } from '../../utils/db-types';
import type { ActionRequest, Request } from '@sap/cds';
import { isNightgateError, NightgateError, errorMessage } from '../../utils/errors';
import { HEX64_ANY_CASE_RE, bareHex } from '../../utils/hex-patterns';
import { withLockContentionRetry } from '../db-write-retry';
const { DELETE, SELECT } = cds.ql;

/**
 * Records a workflow step whose transaction is already on chain. If the write keeps failing, the parent job is parked and its re-run repeats only this write.
 */
export async function recordProven(parentJobId: string, txHash: string, write: () => Promise<unknown>): Promise<void> {
    try {
        await withLockContentionRetry(`recordProven(${parentJobId})`, write);
    } catch (err) {
        throw new WorkflowReconciliationRequiredError(
            `Workflow step of job ${parentJobId} is on chain (${txHash}) but recording it failed: ${errorMessage(err)}`
        );
    }
}

/** Reads the sponsor policy when the job runs, so a revoked grant or a tightened policy also applies to queued jobs. */
export async function liveSponsorPolicyForJob(db: DbRunner, command: { grantId?: string | null }): Promise<SponsorPolicy> {
    const grant = command.grantId ? await currentGrantPolicy(db, command.grantId) : null;
    if (command.grantId && !grant) {
        throw new NightgateError('AGENT_GRANT_REVOKED', `agent grant ${command.grantId} is revoked; nothing was sponsored`);
    }
    return effectiveSponsorPolicy(getGlobalSponsorPolicy(), grant);
}

/** The vault contract only accepts a `valid_until` after the block time and at most 5 years ahead. */
export const CLAIM_MAX_LIFETIME_S = 5 * 365 * 24 * 60 * 60;
export function claimDefaultLifetimeS(): number {
    const configured = configInt('NIGHTGATE_CLAIM_LIFETIME_S') ?? 365 * 24 * 60 * 60;
    return Math.min(configured, CLAIM_MAX_LIFETIME_S - 60);
}
export function claimValidUntil(requested?: number): bigint {
    return BigInt(requested ?? Math.floor(Date.now() / 1000) + claimDefaultLifetimeS());
}
/** Parses an optional caller `validUntil`. On bad input it returns the error text for a 400. */
export function parseValidUntil(raw: unknown): { validUntil?: number; error?: string } {
    if (raw === undefined || raw === null || raw === '') return {};
    const v = Number(raw);
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(v)) return { error: 'validUntil must be an integer UNIX time in seconds' };
    if (v <= now + 60) return { error: 'validUntil must lie at least a minute in the future' };
    if (v > now + CLAIM_MAX_LIFETIME_S) return { error: `validUntil may lie at most ${CLAIM_MAX_LIFETIME_S} seconds (5 years) ahead; the vault refuses longer claims` };
    return { validUntil: v };
}

/** Private proof inputs for one circuit call. Proofs that compare two documents use `docPair` and omit `siblings` and `dirs`. */
export type MerkleProofBundle = {
    fieldValue?: string;
    /** Salt of the field, 64 hex chars. Every single-field proof needs it. */
    fieldSalt?: string;
    fieldDigest?: string;
    siblings?: string[];
    dirs?: boolean[];
    setProof?: { siblings: string[]; dirs: boolean[] };
    docPair?: DocPairBundle;
};

/** Same shape as in document-proof.ts. */
export type SchemaSlotWire = { fieldKey: string; kind: number; scale: string };
/** The private field values of one document, used to prove a comparison of two documents. */
export type OpeningWire = { saltSeed: string; slots: Array<{ present: boolean; value?: string; valueDigest?: string }> };

export type DocPairBundle = {
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
};

export type BatchClaimCommand = {
    predicateAttestationId: string; predicate: string; unit?: string;
    validUntil?: number;
    /** Missing only for the claims that compare two documents. */
    fieldKey?: string;
    /** Salt of the field. Required for single-field claims. */
    salt?: string;
    // numeric ('lessOrEqual' | 'greaterOrEqual')
    threshold?: string; opCode?: number; value?: string;
    // 'bytesEquality'
    expectedDigest?: string;
    // 'setMembership'
    setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
    // 'documentIntegrity' and 'documentDiff'. Document A is the batch payloadHash.
    payloadHashB?: string; attesterIdB?: string; allowedMask?: number; k?: number;
    schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
    siblings?: string[]; dirs?: boolean[];
};

export type ContractCommandV1 =
    | { op: 'deploy'; compiledArtifactRef: string; initialPrivateState: unknown; sponsorSessionId?: string; recoveryId?: string }
    | { op: 'call'; contractAddress: string; circuit: string; compiledArtifactRef: string; args: unknown[]; initialPrivateState?: unknown; sponsorSessionId?: string; merkleProof?: MerkleProofBundle; mintedTokenType?: string }
    | { op: 'callBatch'; contractAddress: string; calls: Array<{ circuit: string; args: unknown[]; merkleProof?: MerkleProofBundle }>; compiledArtifactRef: string; initialPrivateState?: unknown; sponsorSessionId?: string; merkleProof?: MerkleProofBundle; independentCalls?: boolean; orderedPrefix?: number }
    | { op: 'fieldPredicateWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHash: string; attesterId: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; predicate: string; threshold: string; opCode: number; unit?: string; value: string; salt: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldEqualityWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHash: string; attesterId: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; expectedDigest: string; salt: string; siblings: string[]; dirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldMembershipWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHash: string; attesterId: string; fieldKey: string; contractAddress: string; compiledArtifactRef: string; setRoot: string; valueDigest: string; salt: string; siblings: string[]; dirs: boolean[]; setSiblings: string[]; setDirs: boolean[]; contentRoot?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'fieldPredicateBatchWorkflow'; payloadHash: string; attesterId: string; validUntil?: number; contractAddress: string; compiledArtifactRef: string; contentRoot?: string; schemaId?: string; claims: BatchClaimCommand[]; sponsorSessionId?: string }
    | { op: 'documentIntegrityWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHashA: string; payloadHashB: string; attesterIdA: string; attesterIdB: string; contractAddress: string; compiledArtifactRef: string; allowedMask: number; schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire; contentRootA?: string; contentRootB?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'documentDiffWorkflow'; predicateAttestationId: string; validUntil?: number; payloadHashA: string; payloadHashB: string; attesterIdA: string; attesterIdB: string; contractAddress: string; compiledArtifactRef: string; k: number; schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire; contentRootA?: string; contentRootB?: string; schemaId?: string; sponsorSessionId?: string }
    | { op: 'anchorDocument'; documentId: string; payloadHash: string; metadataHash: string; attesterId?: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'grantDisclosure'; disclosureGrantId: string; payloadHash: string; attesterId: string; grantee: string; level: number; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'revokeDisclosure'; payloadHash: string; attesterId: string; grantee: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    | { op: 'registerPassport'; passportId: string; ownerId: string; mode?: number; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string }
    // Retract mode 0 removes the owner's own attestation. attesterId is the session's and is used for the local database update.
    // Mode 1 removes an expired claim.
    | { op: 'retract'; mode: number; key: string; attesterId?: string; contractAddress: string; compiledArtifactRef: string; sponsorSessionId?: string };

/**
 * A command plus the digest of the contract build it was made for. The name can later point to another build, so the digest is checked before running.
 */
export type ContractCommandV1WithProvenance = ContractCommandV1 & { artifactDigest?: string };

/** The command a sponsor job stores. The executor reads the policy again when it runs. */
export type SponsorJobCommand = Partial<Pick<SponsorPolicy, 'allowedContracts' | 'allowedCircuits' | 'allowDeploy' | 'ownContracts' | 'allowedTokenTypes' | 'allowUnshieldedOffers' | 'allowedUnshieldedTokenTypes'>> & {
    sponsorSessionId: string;
    grantId?: string;
} & (
    | { op: 'sponsorFinalized'; finalizedTxB64: string; unboundTxB64?: never; swap?: never; transfer?: never }
    | { op: 'sponsorUnbound'; unboundTxB64?: string; swap?: { makerHalfB64: string; takerHalfB64: string; offerId?: string }; transfer?: { txB64: string; tokenType: string; amount: string } }
);

/** A non-negative integer argument up to `max`: the value, or what is wrong with it. */
export function readUnsignedArg(raw: unknown, name: string, max: bigint, exceeds: string): bigint | string {
    if (raw === undefined || raw === null || raw === '') return `${name} is required`;
    let n: bigint;
    try { n = BigInt(raw as string | number | bigint); } catch { return `${name} must be an integer (decimal string)`; }
    if (n < 0n) return `${name} must be a non-negative integer`;
    if (n > max) return `${name} ${exceeds}`;
    return n;
}

/** The `args` JSON of a contract call: the array, or what is wrong with it. An absent value is no arguments. */
export function readArgsJson(args: string | null | undefined): unknown[] | string {
    if (!args) return [];
    try {
        const v = JSON.parse(args);
        return Array.isArray(v) ? v : 'args must be a JSON array';
    } catch {
        return 'args must be valid JSON';
    }
}

export const VALUE_EXCEEDS = 'exceeds Uint<64>';
export const THRESHOLD_EXCEEDS = 'exceeds the recorded range (at most 9223372036854775807)';

export interface InclusionPath { siblings: string[]; dirs: boolean[] }

/**
 * Checks a fixed-depth Merkle path and returns it with lowercase hashes, or what is wrong. CAP does not check the hex format of `array of Hex64`.
 */
export function readInclusionPath(siblings: unknown, dirs: unknown, depth: number, names: { siblings: string; dirs: string }): InclusionPath | string {
    const sibs = siblings ?? [];
    const ds = dirs ?? [];
    if (!Array.isArray(sibs) || sibs.length !== depth) return `${names.siblings} must be an array of ${depth} hashes`;
    if (!Array.isArray(ds) || ds.length !== depth) return `${names.dirs} must be an array of ${depth} booleans`;
    if (sibs.some(s => typeof s !== 'string' || !HEX64_ANY_CASE_RE.test(s))) return `${names.siblings} entries must be 64 hex chars (32 bytes)`;
    // Only real booleans. Boolean("false") is true and would give a wrong path.
    if (ds.some(d => typeof d !== 'boolean')) return `${names.dirs} entries must be booleans`;
    return { siblings: (sibs as string[]).map(s => s.toLowerCase()), dirs: ds as boolean[] };
}

/** `readInclusionPath` for a request: on bad input it rejects with 400 and returns null. */
export function parseInclusionPath(
    req: ActionRequest<unknown, unknown>, siblings: unknown, dirs: unknown, depth: number, names: { siblings: string; dirs: string }
): InclusionPath | null {
    const path = readInclusionPath(siblings, dirs, depth, names);
    if (typeof path === 'string') { req.reject(400, path); return null; }
    return path;
}

/** `readInclusionPath` that throws the problem, for checks inside a parse loop. */
export function inclusionPathOrThrow(siblings: unknown, dirs: unknown, depth: number, names: { siblings: string; dirs: string }): InclusionPath {
    const path = readInclusionPath(siblings, dirs, depth, names);
    if (typeof path === 'string') throw new Error(path);
    return path;
}

export function validateSchemaSlots(schema: unknown, name: string, width = 16): SchemaSlotWire[] {
    if (!Array.isArray(schema) || schema.length !== width) {
        throw new Error(`${name} must be an array of exactly ${width} slot descriptors`);
    }
    return schema.map((d: any, i: number) => {
        if (!d || typeof d !== 'object') throw new Error(`${name}[${i}] must be an object`);
        if (typeof d.fieldKey !== 'string' || !HEX64_ANY_CASE_RE.test(d.fieldKey)) {
            throw new Error(`${name}[${i}].fieldKey must be 64 hex chars (32 bytes)`);
        }
        if (d.kind !== 0 && d.kind !== 1 && d.kind !== 2) {
            throw new Error(`${name}[${i}].kind must be 0 (uint), 1 (bytes) or 2 (padding)`);
        }
        let scaleBig: bigint;
        try { scaleBig = BigInt(d.scale ?? '0'); } catch { throw new Error(`${name}[${i}].scale must be an integer (decimal string)`); }
        if (scaleBig < 0n || scaleBig > UINT64_MAX) throw new Error(`${name}[${i}].scale must fit Uint<64>`);
        return { fieldKey: d.fieldKey.toLowerCase(), kind: d.kind, scale: scaleBig.toString() };
    });
}

export function validateOpening(opening: unknown, name: string, width = 16): OpeningWire {
    const o = opening as any;
    if (!o || typeof o !== 'object') throw new Error(`${name} must be an object`);
    if (typeof o.saltSeed !== 'string' || !HEX64_ANY_CASE_RE.test(o.saltSeed)) {
        throw new Error(`${name}.saltSeed must be 64 hex chars (32 bytes)`);
    }
    if (!Array.isArray(o.slots) || o.slots.length !== width) {
        throw new Error(`${name}.slots must be an array of exactly ${width} slot openings`);
    }
    const slots = o.slots.map((s: any, i: number) => {
        if (!s || typeof s !== 'object') throw new Error(`${name}.slots[${i}] must be an object`);
        if (typeof s.present !== 'boolean') throw new Error(`${name}.slots[${i}].present must be a boolean`);
        const out: { present: boolean; value?: string; valueDigest?: string } = { present: s.present };
        if (s.value !== undefined) {
            let v: bigint;
            try { v = BigInt(s.value); } catch { throw new Error(`${name}.slots[${i}].value must be an integer (decimal string)`); }
            if (v < 0n || v > UINT64_MAX) throw new Error(`${name}.slots[${i}].value must fit Uint<64>`);
            out.value = v.toString();
        }
        if (s.valueDigest !== undefined) {
            if (typeof s.valueDigest !== 'string' || !HEX64_ANY_CASE_RE.test(s.valueDigest)) {
                throw new Error(`${name}.slots[${i}].valueDigest must be 64 hex chars (32 bytes)`);
            }
            out.valueDigest = s.valueDigest.toLowerCase();
        }
        if (s.present && out.value === undefined && out.valueDigest === undefined) {
            throw new Error(`${name}.slots[${i}]: a present slot needs value or valueDigest`);
        }
        return out;
    });
    return { saltSeed: o.saltSeed.toLowerCase(), slots };
}

/** True when the mask lets every real field change, so the claim is empty. The circuit rejects that, so callers answer 400 before proving. */
export function isVacuousMask(allowedMask: number, schema: SchemaSlotWire[]): boolean {
    return schema.every((s, i) => s.kind === 2 || (allowedMask & (1 << i)) !== 0);
}

/** `PredicateAttestations.threshold` is an Integer64 column, so a stored threshold must stay below 2^63. */
export const INT64_MAX = 9223372036854775807n;

/** Checks the schema and both document openings. On bad input it rejects with 400 and returns null. */
export function parseDocPairInputs(
    req: ActionRequest<unknown, unknown>,
    schema: unknown,
    openingA: unknown,
    openingB: unknown,
    width = 16
): { schema: SchemaSlotWire[]; openingA: OpeningWire; openingB: OpeningWire } | null {
    try {
        return {
            schema: validateSchemaSlots(schema, 'schema', width),
            openingA: validateOpening(openingA, 'openingA', width),
            openingB: validateOpening(openingB, 'openingB', width)
        };
    } catch (e: unknown) {
        req.reject(400, errorMessage(e));
        return null;
    }
}

/**
 * WalletFacade config. Throws on an invalid network name, because the server keeps running after a failed init and must not fall back to a default network.
 */
export function facadeConfigFromEnv() {
    const nightgateConfig = getNightgatePluginConfig();
    const { network, nodeUrl, submissionEndpoints, invalidNetwork } = resolveNightgateRuntimeConfig(nightgateConfig);
    if (invalidNetwork) {
        throw new Error(
            `Invalid network "${invalidNetwork}"; refusing to submit against the "${network}" fallback. ` +
            `Fix NIGHTGATE_NETWORK / cds.requires.nightgate.network.`);
    }
    return {
        networkId: network as 'preprod' | 'testnet' | 'mainnet' | 'undeployed',
        indexerHttpUrl: submissionEndpoints.indexerHttpUrl,
        indexerWsUrl: submissionEndpoints.indexerWsUrl,
        proofServerUrl: submissionEndpoints.proofServerUrl,
        relayUrl: nodeUrl
    };
}

export function recordedNetworkId(): string | null {
    try { return facadeConfigFromEnv().networkId ?? null; } catch { return null; }
}

export function artifactDigestOrNull(compiledRef: string): string | null {
    try { return getArtifactGenerationDigest(compiledRef); } catch { return null; }
}

/** Rejects with 403 and returns true when mainnet submission is not allowed. Call it before any work. */
export function rejectIfMainnetBlocked(req: ActionRequest<unknown, unknown>): boolean {
    const reason = mainnetSubmissionBlockReason(getNightgatePluginConfig());
    if (reason) {
        req.reject?.(403, reason);
        return true;
    }
    return false;
}

/**
 * Runs `insertRows`, then starts the job. The rows are removed again when no job starts or a repeated request reuses an earlier job.
 */
export async function startJobWithRows<R extends StartJobResult>(
    db: DbRunner, entity: typeof Documents | typeof PredicateAttestations, ids: string[],
    insertRows: unknown, start: () => Promise<R>
): Promise<R> {
    await db.run(insertRows);
    const drop = () => db.run(DELETE.from(entity).where({ ID: { in: ids } }));
    let job: R;
    try {
        job = await start();
    } catch (err) {
        await drop();
        throw err;
    }
    if (job.deduplicated) await drop();
    return job;
}

/** A grant's value budget takes the amount a call moves out. Calls without a grant have no budget. Returns false after rejecting. */
export async function takeValueBudget(req: Request, db: DbRunner, tokenType: string, amount: bigint): Promise<boolean> {
    const grantId = req.agentGrant?.ID;
    if (!grantId) return true;
    return consumeValueBudget(db, req, String(grantId), tokenType, amount);
}

/** Runs `fn` in one transaction of `db`, commit on return and rollback on throw. A test double without `tx` runs it directly. */
export async function runInOneTransaction<T>(db: TxCapableDb, fn: (tx: DbRunner) => Promise<T>): Promise<T> {
    if (typeof db?.tx === 'function') return db.tx(fn);
    return fn(db);
}

export function setRetryAfter(req: ActionRequest<unknown, unknown>, seconds: number): void {
    try { req.http?.res?.set?.('Retry-After', String(seconds)); } catch { /* header is a courtesy */ }
}

export async function runSubmission<T>(req: ActionRequest<unknown, unknown>, op: () => Promise<T>): Promise<T> {
    try {
        return await op();
    } catch (err) {
        if (isNightgateError(err)) {
            if (err.code === 'JOB_ADMISSION_BUSY') setRetryAfter(req, (err as { retryAfterSeconds?: number }).retryAfterSeconds ?? 2);
            return req.reject(err);
        }
        const msg = errorMessage(err);
        return req.reject(500, msg);
    }
}

/** True when the indexed transaction of a job's txHash landed with a success outcome. Matches the ledger hash, or the extrinsic hash older rows hold. */
export async function landedOnChain(db: DbRunner, txHash: string | null | undefined): Promise<boolean> {
    const bare = bareHex(txHash);
    if (!bare) return false;
    const tx: Pick<Transaction, 'ID'> | undefined = await db.run(
        SELECT.one.from(Transactions).columns('ID').where`ledgerTxHash = ${bare} or hash = ${'0x' + bare}`
    );
    if (!tx?.ID) return false;
    const result: Pick<TransactionResult, 'status' | 'outcomeSource'> | undefined = await db.run(
        SELECT.one.from(TransactionResults).columns('status', 'outcomeSource').where({ transaction_ID: tx.ID })
    );
    return result?.status === 'SUCCESS' && result?.outcomeSource === 'substrate-system-events';
}
