/**
 * Actions that prove facts about document fields, and comparisons between two documents.
 * SPDX-License-Identifier: Apache-2.0
 */
import cds from '@sap/cds';
import { type NightgateNetwork, VALID_NIGHTGATE_NETWORKS } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { startJob } from '../background-jobs';
import { DEFAULT_ATTESTATION_VAULT_REF, UINT64_MAX, vaultDims, parsePredicate, coerceMask, liveProviderConfigured } from '../verify-state';
import { blake2b256Hex, PureCircuitsUnavailableError } from '../document-proof';
import { membershipPathFor, SET_DEPTH } from '../set-root';
import { Transactions, TransactionResults, PredicateAttestations, type Transaction } from '#cds-models/midnight';
import { predicateRateLimiter, parseValidUntil, SchemaSlotWire, OpeningWire, parseInclusionPath, validateSchemaSlots, validateOpening, isVacuousMask, INT64_MAX, parseDocPairInputs, facadeConfigFromEnv, recordedNetworkId, artifactDigestOrNull, rejectIfMainnetBlocked, checkRate, runSubmission } from './common';
import type { SubmissionContext } from './context';
import { HEX64_ANY_CASE_RE } from '../../utils/hex-patterns';
import { issueDocumentDiffAttestation, issueDocumentIntegrityAttestation, issueFieldEqualityAttestation, issueFieldMembershipAttestation, issueFieldPredicateAttestation, issueFieldPredicateAttestationBatch, verifyPredicateAttestation } from '#cds-models/NightgateService';

const { INSERT, SELECT, DELETE } = cds.ql;

export function registerPredicateActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'contractResolver' | 'pureCircuitsLoader' | 'verifyPredicateViaState' | 'resolveAttester' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, contractResolver, pureCircuitsLoader, verifyPredicateViaState, resolveAttester, resolveSponsorForRequest } = ctx;

    srv.on(issueFieldPredicateAttestation, async (req) => {
        const data = req.data;

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');
        if (data.value === undefined || data.value === null || data.value === '') {
            return req.reject(400, 'value is required');
        }
        let valueBig: bigint;
        try { valueBig = BigInt(data.value); } catch { return req.reject(400, 'value must be an integer (decimal string)'); }
        if (valueBig < 0n) return req.reject(400, 'value must be a non-negative integer');
        if (valueBig > UINT64_MAX) return req.reject(400, 'value exceeds Uint<64>');
        if (!data.fieldSalt) {
            return req.reject(400, 'fieldSalt is required (v4 salted leaves; prepareDocumentProof returns it per field)');
        }

        if (data.threshold === undefined || data.threshold === null) return req.reject(400, 'threshold is required');
        let thresholdBig: bigint;
        try { thresholdBig = BigInt(data.threshold); } catch { return req.reject(400, 'threshold must be an integer'); }
        if (thresholdBig < 0n) return req.reject(400, 'threshold must be a non-negative integer');
        if (thresholdBig > INT64_MAX) return req.reject(400, 'threshold exceeds the recorded range (at most 9223372036854775807)');

        const parsedPredicate = parsePredicate(data.predicate);
        if (!parsedPredicate || parsedPredicate.kind !== 'numeric') {
            return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual' (use issueFieldEqualityAttestation / issueFieldMembershipAttestation for the bytes kinds)");
        }
        const op = parsedPredicate.opCode!;

        const { depth } = vaultDims(data.compiledArtifactRef);
        let siblings: string[];
        let dirs: boolean[];
        try { siblings = JSON.parse(data.siblingsJson ?? '[]'); } catch { return req.reject(400, 'siblingsJson must be a JSON array'); }
        try { dirs = JSON.parse(data.dirsJson ?? '[]'); } catch { return req.reject(400, 'dirsJson must be a JSON array'); }
        if (!Array.isArray(siblings) || siblings.length !== depth) return req.reject(400, `siblingsJson must be a JSON array of ${depth} hashes`);
        if (!Array.isArray(dirs) || dirs.length !== depth) return req.reject(400, `dirsJson must be a JSON array of ${depth} booleans`);
        for (const s of siblings) {
            if (typeof s !== 'string' || !HEX64_ANY_CASE_RE.test(s)) return req.reject(400, 'each sibling must be 64 hex chars (32 bytes)');
        }
        for (const d of dirs) {
            // Only real booleans. Boolean("false") is true and would give a wrong path.
            if (typeof d !== 'boolean') return req.reject(400, 'dirsJson entries must be booleans');
        }
        const dirsBool = dirs as boolean[];

        if (data.contentRoot && !data.schemaId) {
            return req.reject(400, 'schemaId is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        const contractAddress = data.contractAddress;
        if (!contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            attesterId,
            contractAddress,
            predicate: parsedPredicate.predicate,
            op,
            threshold: data.threshold,
            unit: data.unit ?? null,
            // The verify functions need it to look up the claim on-chain.
            fieldKey: data.fieldKey.toLowerCase(),
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueFieldPredicateAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: data.predicate,
                    threshold: String(data.threshold),
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: data.predicate,
                    threshold: String(data.threshold), value: data.value, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId, siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldPredicateWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    predicate: data.predicate!, threshold: thresholdBig.toString(), opCode: op,
                    unit: data.unit, value: valueBig.toString(), salt: data.fieldSalt!.toLowerCase(),
                    siblings: siblings.map(s => s.toLowerCase()),
                    dirs: dirsBool, contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on(issueFieldEqualityAttestation, async (req) => {
        const data = req.data;

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');

        const hasValue = typeof data.expectedValue === 'string' && data.expectedValue.length > 0;
        const hasDigest = typeof data.expectedDigest === 'string' && data.expectedDigest.length > 0;
        if (hasValue === hasDigest) return req.reject(400, 'pass exactly one of expectedValue / expectedDigest');
        // Hash the exact string, untrimmed, the same way prepareDocumentProof hashes text fields.
        const expectedDigest = hasDigest ? data.expectedDigest!.toLowerCase() : blake2b256Hex(data.expectedValue!);
        if (!data.fieldSalt) {
            return req.reject(400, 'fieldSalt is required (v4 salted leaves; prepareDocumentProof returns it per field)');
        }

        const path = parseInclusionPath(req, data.siblingsJson, data.dirsJson, vaultDims(data.compiledArtifactRef).depth, { siblings: 'siblingsJson', dirs: 'dirsJson' });
        if (!path) return;
        if (data.contentRoot && !data.schemaId) {
            return req.reject(400, 'schemaId is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // No operator or threshold here. The claim is the expected digest itself.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            attesterId,
            contractAddress: data.contractAddress,
            predicate: 'bytesEquality',
            op: null,
            threshold: null,
            unit: null,
            fieldKey: data.fieldKey.toLowerCase(),
            expectedDigest,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueFieldEqualityAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: 'bytesEquality',
                    expectedDigest,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'bytesEquality',
                    expectedDigest, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId,
                    siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldEqualityWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    expectedDigest, salt: data.fieldSalt!.toLowerCase(), siblings: path.siblings, dirs: path.dirs,
                    contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on(issueFieldMembershipAttestation, async (req) => {
        const data = req.data;

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');

        const hasValue = typeof data.value === 'string' && data.value.length > 0;
        const hasDigest = typeof data.valueDigest === 'string' && data.valueDigest.length > 0;
        if (hasValue === hasDigest) return req.reject(400, 'pass exactly one of value / valueDigest');
        const valueDigest = hasDigest ? data.valueDigest!.toLowerCase() : blake2b256Hex(data.value!);
        if (!data.fieldSalt) {
            return req.reject(400, 'fieldSalt is required (v4 salted leaves; prepareDocumentProof returns it per field)');
        }

        const hasList = typeof data.allowedValuesJson === 'string' && data.allowedValuesJson.length > 0;
        const hasSetPath = !!(data.setRoot || data.setSiblingsJson || data.setDirsJson);
        if (hasList && hasSetPath) {
            return req.reject(400, 'pass either allowedValuesJson or setRoot + setSiblingsJson + setDirsJson, not both');
        }
        if (!hasList && !(data.setRoot && data.setSiblingsJson && data.setDirsJson)) {
            return req.reject(400, 'allowedValuesJson or setRoot + setSiblingsJson + setDirsJson is required');
        }

        const path = parseInclusionPath(req, data.siblingsJson, data.dirsJson, vaultDims(data.compiledArtifactRef).depth, { siblings: 'siblingsJson', dirs: 'dirsJson' });
        if (!path) return;
        if (data.contentRoot && !data.schemaId) {
            return req.reject(400, 'schemaId is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        // Build the set before the rate limit check, so a value missing from the list costs no budget.
        let setRoot: string;
        let setSiblings: string[];
        let setDirs: boolean[];
        if (hasList) {
            let allowed: unknown;
            try { allowed = JSON.parse(data.allowedValuesJson!); } catch { return req.reject(400, 'allowedValuesJson must be valid JSON'); }
            if (!Array.isArray(allowed) || allowed.length === 0 || allowed.some(v => typeof v !== 'string' || v.length === 0)) {
                return req.reject(400, 'allowedValuesJson must be a non-empty JSON array of non-empty strings');
            }
            // Every entry is hashed before duplicates are removed, so limit the raw list size.
            if (allowed.length > 1024) {
                return req.reject(400, 'allowedValuesJson supports at most 1024 raw entries (64 distinct values)');
            }
            let pure;
            try {
                pure = await pureCircuitsLoader(compiledRef);
            } catch (err) {
                if (err instanceof PureCircuitsUnavailableError) return req.reject(404, err.message);
                throw err;
            }
            let member;
            try {
                member = membershipPathFor(allowed as string[], valueDigest, pure);
            } catch (err) {
                return req.reject(400, (err as Error).message);
            }
            if (!member) return req.reject(400, 'value is not in the allowed list');
            setRoot = member.setRoot;
            setSiblings = member.setSiblings;
            setDirs = member.setDirs;
        } else {
            const setPath = parseInclusionPath(req, data.setSiblingsJson, data.setDirsJson, SET_DEPTH, { siblings: 'setSiblingsJson', dirs: 'setDirsJson' });
            if (!setPath) return;
            setRoot = data.setRoot!.toLowerCase();
            setSiblings = setPath.siblings;
            setDirs = setPath.dirs;
        }

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // Only the set root is public. The value digest and the paths stay private proof inputs.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHash.toLowerCase(),
            attesterId,
            contractAddress: data.contractAddress,
            predicate: 'setMembership',
            op: null,
            threshold: null,
            unit: null,
            fieldKey: data.fieldKey.toLowerCase(),
            setRoot,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueFieldMembershipAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress,
                    predicate: 'setMembership',
                    setRoot,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress, predicate: 'setMembership',
                    setRoot, valueDigest, fieldSalt: data.fieldSalt,
                    contentRoot: data.contentRoot, schemaId: data.schemaId,
                    siblingsJson: data.siblingsJson, dirsJson: data.dirsJson,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldMembershipWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(), attesterId, fieldKey: data.fieldKey!.toLowerCase(),
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    setRoot, valueDigest, salt: data.fieldSalt!.toLowerCase(),
                    siblings: path.siblings, dirs: path.dirs,
                    setSiblings, setDirs,
                    contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on(issueDocumentIntegrityAttestation, async (req) => {
        const data = req.data;

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHashA) return req.reject(400, 'payloadHashA is required');
        if (!data.payloadHashB) return req.reject(400, 'payloadHashB is required');
        if (data.payloadHashA.toLowerCase() === data.payloadHashB.toLowerCase()) {
            return req.reject(400, 'payloadHashA and payloadHashB must differ (a document is trivially unchanged against itself)');
        }
        const { width: intWidth, maxMask } = vaultDims(data.compiledArtifactRef);
        if (data.allowedMask === undefined || data.allowedMask === null) return req.reject(400, 'allowedMask is required');
        const allowedMask = coerceMask(data.allowedMask);
        if (allowedMask === null || allowedMask < 0 || allowedMask > maxMask) {
            return req.reject(400, `allowedMask must be an integer in 0..${maxMask} (packed ${intWidth}-bit slot mask)`);
        }
        if (allowedMask === maxMask) {
            return req.reject(400, `allowedMask ${maxMask} permits every slot to differ; the claim would be vacuous`);
        }
        const docPair = parseDocPairInputs(req, data.schemaJson, data.openingAJson, data.openingBJson, intWidth);
        if (!docPair) return;
        if (isVacuousMask(allowedMask, docPair.schema)) {
            return req.reject(400, 'allowedMask frees every real (non-padding) schema slot; the claim would be vacuous');
        }
        if ((data.contentRootA || data.contentRootB) && !data.schemaId) {
            return req.reject(400, 'schemaId is required when anchoring a content root (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // Document A is stored in the payloadHash column.
        const attesterIdA = await resolveAttester(req, data.sessionId, data.attesterIdA, Boolean(data.contentRootA));
        if (!attesterIdA) return;
        const attesterIdB = await resolveAttester(req, data.sessionId, data.attesterIdB ?? attesterIdA, Boolean(data.contentRootB));
        if (!attesterIdB) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHashA.toLowerCase(),
            attesterId: attesterIdA,
            contractAddress: data.contractAddress,
            predicate: 'documentIntegrity',
            op: null,
            threshold: null,
            unit: null,
            fieldKey: null,
            expectedDigest: null,
            setRoot: null,
            payloadHashB: data.payloadHashB.toLowerCase(),
            attesterIdB,
            allowedMask,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueDocumentIntegrityAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHashA: data.payloadHashA!.toLowerCase(),
                    payloadHashB: data.payloadHashB!.toLowerCase(),
                    attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress,
                    predicate: 'documentIntegrity',
                    allowedMask,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress, predicate: 'documentIntegrity',
                    allowedMask,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase() ?? null,
                    contentRootB: data.contentRootB?.toLowerCase() ?? null,
                    schemaId: data.schemaId?.toLowerCase() ?? null,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'documentIntegrityWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    allowedMask,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase(),
                    contentRootB: data.contentRootB?.toLowerCase(),
                    schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on(issueDocumentDiffAttestation, async (req) => {
        const data = req.data;

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHashA) return req.reject(400, 'payloadHashA is required');
        if (!data.payloadHashB) return req.reject(400, 'payloadHashB is required');
        if (data.payloadHashA.toLowerCase() === data.payloadHashB.toLowerCase()) {
            return req.reject(400, 'payloadHashA and payloadHashB must differ (a document has no differences against itself)');
        }
        const { width: diffWidth } = vaultDims(data.compiledArtifactRef);
        if (data.k === undefined || data.k === null) return req.reject(400, 'k is required');
        if (!Number.isInteger(data.k) || data.k < 1 || data.k > diffWidth) {
            return req.reject(400, `k must be an integer in 1..${diffWidth} (minimum differing slots)`);
        }
        const docPair = parseDocPairInputs(req, data.schemaJson, data.openingAJson, data.openingBJson, diffWidth);
        if (!docPair) return;
        if ((data.contentRootA || data.contentRootB) && !data.schemaId) {
            return req.reject(400, 'schemaId is required when anchoring a content root (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRate(predicateRateLimiter, data.sessionId, req)) return;

        // k is stored in the threshold column.
        const attesterIdA = await resolveAttester(req, data.sessionId, data.attesterIdA, Boolean(data.contentRootA));
        if (!attesterIdA) return;
        const attesterIdB = await resolveAttester(req, data.sessionId, data.attesterIdB ?? attesterIdA, Boolean(data.contentRootB));
        if (!attesterIdB) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        await db.run(INSERT.into(PredicateAttestations).entries({
            ID: predicateAttestationId,
            payloadHash: data.payloadHashA.toLowerCase(),
            attesterId: attesterIdA,
            contractAddress: data.contractAddress,
            predicate: 'documentDiff',
            op: null,
            threshold: data.k,
            unit: null,
            fieldKey: null,
            expectedDigest: null,
            setRoot: null,
            payloadHashB: data.payloadHashB.toLowerCase(),
            attesterIdB,
            allowedMask: null,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJob({
                kind: 'issueDocumentDiffAttestation',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHashA: data.payloadHashA!.toLowerCase(),
                    payloadHashB: data.payloadHashB!.toLowerCase(),
                    attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress,
                    predicate: 'documentDiff',
                    k: data.k,
                    predicateAttestationId,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress, predicate: 'documentDiff',
                    k: data.k,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase() ?? null,
                    contentRootB: data.contentRootB?.toLowerCase() ?? null,
                    schemaId: data.schemaId?.toLowerCase() ?? null,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'documentDiffWorkflow', predicateAttestationId, validUntil: validUntilArg,
                    payloadHashA: data.payloadHashA!.toLowerCase(), payloadHashB: data.payloadHashB!.toLowerCase(), attesterIdA, attesterIdB,
                    contractAddress: data.contractAddress!, compiledArtifactRef: compiledRef,
                    k: data.k!,
                    schema: docPair.schema, openingA: docPair.openingA, openingB: docPair.openingB,
                    contentRootA: data.contentRootA?.toLowerCase(),
                    contentRootB: data.contentRootB?.toLowerCase(),
                    schemaId: data.schemaId?.toLowerCase(),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            if (job.deduplicated) await db.run(DELETE.from(PredicateAttestations).where({ ID: predicateAttestationId }));
            const stablePredicateId = (job.originalRequest as any)?.predicateAttestationId ?? predicateAttestationId;
            return { jobId: job.jobId, status: job.status, predicateAttestationId: stablePredicateId };
        });
    });

    srv.on(issueFieldPredicateAttestationBatch, async (req) => {
        const data = req.data;

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (data.contentRoot && !data.schemaId) {
            return req.reject(400, 'schemaId is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        const contractAddress = data.contractAddress;
        if (!contractAddress) return req.reject(400, 'contractAddress is required');
        if (!data.claimsJson) return req.reject(400, 'claimsJson is required');

        // At most 8 calls per transaction. Storing the contentRoot in the same batch uses one of them.
        const maxClaims = data.contentRoot ? 7 : 8;
        // `allowedValues` is the raw list of a membership claim, before the set is built.
        // Document comparisons have no fieldKey or path. Document A is the batch payloadHash.
        interface BatchClaim {
            fieldKey?: string; siblings?: string[]; dirs?: boolean[];
            predicate: string; unit?: string;
            value?: string; threshold?: string; opCode?: number;
            expectedDigest?: string;
            setRoot?: string; valueDigest?: string; setSiblings?: string[]; setDirs?: boolean[];
            allowedValues?: string[];
            salt?: string;
            payloadHashB?: string; attesterIdB?: string; allowedMask?: number; k?: number;
            schema?: SchemaSlotWire[]; openingA?: OpeningWire; openingB?: OpeningWire;
        }
        const parsePath = (entry: any, i: number, depth: number, sibName: string, dirName: string): { siblings: string[]; dirs: boolean[] } => {
            const sibs = entry[sibName];
            const ds = entry[dirName];
            if (!Array.isArray(sibs) || sibs.length !== depth) {
                throw new Error(`claims[${i}].${sibName} must be a JSON array of ${depth} hashes`);
            }
            for (const s of sibs) {
                if (typeof s !== 'string' || !HEX64_ANY_CASE_RE.test(s)) throw new Error(`claims[${i}].${sibName} entries must be 64 hex chars (32 bytes)`);
            }
            if (!Array.isArray(ds) || ds.length !== depth) {
                throw new Error(`claims[${i}].${dirName} must be a JSON array of ${depth} booleans`);
            }
            for (const d of ds) {
                // Only real booleans. Boolean("false") is true and would give a wrong path.
                if (typeof d !== 'boolean') throw new Error(`claims[${i}].${dirName} entries must be booleans`);
            }
            return { siblings: sibs.map((s: string) => s.toLowerCase()), dirs: ds as boolean[] };
        };
        const { width: batchWidth, depth: batchDepth, maxMask: batchMaxMask } = vaultDims(data.compiledArtifactRef);
        let claims: BatchClaim[];
        try {
            const v = JSON.parse(data.claimsJson);
            if (!Array.isArray(v) || v.length === 0) return req.reject(400, 'claimsJson must be a non-empty JSON array');
            if (v.length > maxClaims) {
                return req.reject(400, `claimsJson supports at most ${maxClaims} entries per batch` + (data.contentRoot ? ' (the contentRoot anchor occupies one of the 8 call slots)' : ''));
            }
            claims = v.map((entry: any, i: number): BatchClaim => {
                if (!entry || typeof entry !== 'object') throw new Error(`claims[${i}] must be an object`);
                const parsed = parsePredicate(entry.predicate);
                if (!parsed) throw new Error(`claims[${i}].predicate must be 'lessOrEqual', 'greaterOrEqual', 'bytesEquality', 'setMembership', 'documentIntegrity' or 'documentDiff'`);

                if (parsed.kind === 'integrity' || parsed.kind === 'diff') {
                    // A contentRoot sent with the batch belongs to document A. Document B's root must already be on-chain.
                    if (typeof entry.payloadHashB !== 'string' || !HEX64_ANY_CASE_RE.test(entry.payloadHashB)) {
                        throw new Error(`claims[${i}].payloadHashB must be 64 hex chars (32 bytes)`);
                    }
                    const payloadHashB = entry.payloadHashB.toLowerCase();
                    if (entry.attesterIdB !== undefined && (typeof entry.attesterIdB !== 'string' || !HEX64_ANY_CASE_RE.test(entry.attesterIdB))) {
                        throw new Error(`claims[${i}].attesterIdB must be 64 hex chars (32 bytes)`);
                    }
                    const attesterIdB = typeof entry.attesterIdB === 'string' ? entry.attesterIdB.toLowerCase() : undefined;
                    if (payloadHashB === data.payloadHash!.toLowerCase()) {
                        throw new Error(`claims[${i}].payloadHashB must differ from the batch payloadHash`);
                    }
                    const schema = validateSchemaSlots(entry.schema, `claims[${i}].schema`, batchWidth);
                    const openingA = validateOpening(entry.openingA, `claims[${i}].openingA`, batchWidth);
                    const openingB = validateOpening(entry.openingB, `claims[${i}].openingB`, batchWidth);
                    if (parsed.kind === 'integrity') {
                        if (!Number.isInteger(entry.allowedMask) || entry.allowedMask < 0 || entry.allowedMask > batchMaxMask) {
                            throw new Error(`claims[${i}].allowedMask must be an integer in 0..${batchMaxMask}`);
                        }
                        if (entry.allowedMask === batchMaxMask) {
                            throw new Error(`claims[${i}].allowedMask ${batchMaxMask} permits every slot to differ; the claim would be vacuous`);
                        }
                        if (isVacuousMask(entry.allowedMask, schema)) {
                            throw new Error(`claims[${i}].allowedMask frees every real (non-padding) schema slot; the claim would be vacuous`);
                        }
                        return {
                            predicate: 'documentIntegrity', payloadHashB, attesterIdB, allowedMask: entry.allowedMask,
                            schema, openingA, openingB
                        };
                    }
                    if (!Number.isInteger(entry.k) || entry.k < 1 || entry.k > batchWidth) {
                        throw new Error(`claims[${i}].k must be an integer in 1..${batchWidth}`);
                    }
                    return {
                        predicate: 'documentDiff', payloadHashB, attesterIdB, k: entry.k,
                        schema, openingA, openingB
                    };
                }

                if (typeof entry.fieldKey !== 'string' || !HEX64_ANY_CASE_RE.test(entry.fieldKey)) {
                    throw new Error(`claims[${i}].fieldKey must be 64 hex chars (32 bytes)`);
                }
                const contentPath = parsePath(entry, i, batchDepth, 'siblings', 'dirs');
                if (typeof entry.salt !== 'string' || !HEX64_ANY_CASE_RE.test(entry.salt)) {
                    throw new Error(`claims[${i}].salt must be 64 hex chars (32 bytes; v4 salted leaves)`);
                }
                const base = {
                    fieldKey: entry.fieldKey.toLowerCase(),
                    salt: entry.salt.toLowerCase(),
                    siblings: contentPath.siblings,
                    dirs: contentPath.dirs,
                    predicate: entry.predicate as string,
                    unit: typeof entry.unit === 'string' && entry.unit.length > 0 ? entry.unit : undefined
                };

                if (parsed.kind === 'equality') {
                    const hasVal = typeof entry.expectedValue === 'string' && entry.expectedValue.length > 0;
                    const hasDig = typeof entry.expectedDigest === 'string' && entry.expectedDigest.length > 0;
                    if (hasVal === hasDig) throw new Error(`claims[${i}]: pass exactly one of expectedValue / expectedDigest`);
                    if (hasDig && !HEX64_ANY_CASE_RE.test(entry.expectedDigest)) throw new Error(`claims[${i}].expectedDigest must be 64 hex chars (32 bytes)`);
                    return { ...base, expectedDigest: hasDig ? entry.expectedDigest.toLowerCase() : blake2b256Hex(entry.expectedValue) };
                }

                if (parsed.kind === 'membership') {
                    const hasVal = typeof entry.value === 'string' && entry.value.length > 0;
                    const hasDig = typeof entry.valueDigest === 'string' && entry.valueDigest.length > 0;
                    if (hasVal === hasDig) throw new Error(`claims[${i}]: pass exactly one of value / valueDigest`);
                    if (hasDig && !HEX64_ANY_CASE_RE.test(entry.valueDigest)) throw new Error(`claims[${i}].valueDigest must be 64 hex chars (32 bytes)`);
                    const valueDigest = hasDig ? entry.valueDigest.toLowerCase() : blake2b256Hex(entry.value);
                    const hasAllowed = Array.isArray(entry.allowedValues);
                    const hasSetPath = !!(entry.setRoot || entry.setSiblings || entry.setDirs);
                    if (hasAllowed && hasSetPath) throw new Error(`claims[${i}]: pass either allowedValues or setRoot + setSiblings + setDirs, not both`);
                    if (hasAllowed) {
                        if ((entry.allowedValues as unknown[]).length === 0 || (entry.allowedValues as unknown[]).some(x => typeof x !== 'string' || x.length === 0)) {
                            throw new Error(`claims[${i}].allowedValues must be a non-empty array of non-empty strings`);
                        }
                        if ((entry.allowedValues as unknown[]).length > 1024) {
                            throw new Error(`claims[${i}].allowedValues supports at most 1024 raw entries (64 distinct values)`);
                        }
                        return { ...base, valueDigest, allowedValues: entry.allowedValues as string[] };
                    }
                    if (!(entry.setRoot && entry.setSiblings && entry.setDirs)) {
                        throw new Error(`claims[${i}]: allowedValues or setRoot + setSiblings + setDirs is required`);
                    }
                    if (typeof entry.setRoot !== 'string' || !HEX64_ANY_CASE_RE.test(entry.setRoot)) throw new Error(`claims[${i}].setRoot must be 64 hex chars (32 bytes)`);
                    const setPath = parsePath(entry, i, SET_DEPTH, 'setSiblings', 'setDirs');
                    return { ...base, valueDigest, setRoot: entry.setRoot.toLowerCase(), setSiblings: setPath.siblings, setDirs: setPath.dirs };
                }

                if (entry.value === undefined || entry.value === null || entry.value === '') {
                    throw new Error(`claims[${i}].value is required`);
                }
                let valueBig: bigint;
                try { valueBig = BigInt(entry.value); } catch { throw new Error(`claims[${i}].value must be an integer (decimal string)`); }
                if (valueBig < 0n) throw new Error(`claims[${i}].value must be a non-negative integer`);
                if (valueBig > UINT64_MAX) throw new Error(`claims[${i}].value exceeds Uint<64>`);
                if (entry.threshold === undefined || entry.threshold === null) throw new Error(`claims[${i}].threshold is required`);
                let thresholdBig: bigint;
                try { thresholdBig = BigInt(entry.threshold); } catch { throw new Error(`claims[${i}].threshold must be an integer`); }
                if (thresholdBig < 0n) throw new Error(`claims[${i}].threshold must be a non-negative integer`);
                if (thresholdBig > INT64_MAX) throw new Error(`claims[${i}].threshold exceeds the recorded range (at most 9223372036854775807)`);
                return { ...base, value: valueBig.toString(), threshold: thresholdBig.toString(), opCode: parsed.opCode! };
            });
        } catch (e: unknown) {
            return req.reject(400, e instanceof Error && /^claims\[/.test(e.message) ? e.message : 'claimsJson must be valid JSON');
        }

        const compiledRef = data.compiledArtifactRef && data.compiledArtifactRef.length > 0
            ? data.compiledArtifactRef
            : DEFAULT_ATTESTATION_VAULT_REF;

        // Build the sets first. Duplicate removal needs the set root, and a value
        // missing from the list must not count against the rate limit.
        if (claims.some(c => c.allowedValues)) {
            let pure;
            try {
                pure = await pureCircuitsLoader(compiledRef);
            } catch (err) {
                if (err instanceof PureCircuitsUnavailableError) return req.reject(404, err.message);
                throw err;
            }
            for (let i = 0; i < claims.length; i++) {
                const c = claims[i];
                if (!c.allowedValues) continue;
                let member;
                try {
                    member = membershipPathFor(c.allowedValues, c.valueDigest!, pure);
                } catch (err) {
                    return req.reject(400, `claims[${i}]: ${(err as Error).message}`);
                }
                if (!member) return req.reject(400, `claims[${i}]: value is not in the allowed list`);
                c.setRoot = member.setRoot;
                c.setSiblings = member.setSiblings;
                c.setDirs = member.setDirs;
                delete c.allowedValues;
            }
        }

        // Drop duplicate claims. Proving one twice only costs time.
        // The tuple has the same fields as the claim stored on-chain.
        const seenTuples = new Set<string>();
        const uniqueClaims: BatchClaim[] = [];
        for (const c of claims) {
            const tuple = c.predicate === 'bytesEquality' ? `${c.fieldKey}|eq|${c.expectedDigest}`
                : c.predicate === 'setMembership' ? `${c.fieldKey}|set|${c.setRoot}`
                : c.predicate === 'documentIntegrity' ? `${c.attesterIdB ?? ''}|${c.payloadHashB}|integ|${c.allowedMask}`
                : c.predicate === 'documentDiff' ? `${c.attesterIdB ?? ''}|${c.payloadHashB}|diff|${c.k}`
                : `${c.fieldKey}|${c.threshold}|${c.opCode}`;
            if (seenTuples.has(tuple)) continue;
            seenTuples.add(tuple);
            uniqueClaims.push(c);
        }
        const droppedDuplicates = claims.length - uniqueClaims.length;

        if (rejectIfMainnetBlocked(req)) return;
        // Each claim counts against the rate limit, so a batch cannot bypass it.
        if (!checkRate(predicateRateLimiter, data.sessionId, req, uniqueClaims.length)) return;

        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const insertedAt = new Date().toISOString();
        const rowedClaims = uniqueClaims.map(c => ({ ...c, predicateAttestationId: cds.utils.uuid() }));
        await db.run(INSERT.into(PredicateAttestations).entries(rowedClaims.map(c => ({
            ID: c.predicateAttestationId,
            payloadHash: data.payloadHash!.toLowerCase(),
            attesterId,
            contractAddress,
            predicate: c.predicate,
            op: c.opCode ?? null,
            threshold: (c.predicate === 'documentDiff' ? c.k : c.threshold ?? null) as any,
            unit: c.unit ?? null,
            fieldKey: c.fieldKey ?? null,
            expectedDigest: c.expectedDigest ?? null,
            setRoot: c.setRoot ?? null,
            payloadHashB: c.payloadHashB ?? null,
            attesterIdB: c.attesterIdB ?? null,
            allowedMask: c.allowedMask ?? null,
            network: recordedNetworkId(),
            compiledArtifactRef: compiledRef,
            artifactDigest: artifactDigestOrNull(compiledRef),
            provenTxHash: null,
            provenAt: null,
            createdAt: insertedAt,
            modifiedAt: insertedAt
        }))));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const publicClaims = rowedClaims.map(c => ({
                predicateAttestationId: c.predicateAttestationId, fieldKey: c.fieldKey,
                predicate: c.predicate,
                ...(c.predicate === 'bytesEquality' ? { expectedDigest: c.expectedDigest }
                    : c.predicate === 'setMembership' ? { setRoot: c.setRoot }
                    : c.predicate === 'documentIntegrity' ? { payloadHashB: c.payloadHashB, allowedMask: c.allowedMask }
                    : c.predicate === 'documentDiff' ? { payloadHashB: c.payloadHashB, k: c.k }
                    : { threshold: c.threshold, unit: c.unit ?? null })
            }));
            const job = await startJob({
                kind: 'issueFieldPredicateAttestationBatch',
                sessionId: data.sessionId!,
                idempotencyKey: data.idempotencyKey,
                request: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress,
                    claimCount: rowedClaims.length,
                    claims: publicClaims,
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                idempotencyPayload: {
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress,
                    contentRoot: data.contentRoot?.toLowerCase() ?? null,
                    claims: uniqueClaims.map(c => ({
                        fieldKey: c.fieldKey, predicate: c.predicate, threshold: c.threshold,
                        value: c.value, expectedDigest: c.expectedDigest,
                        setRoot: c.setRoot, valueDigest: c.valueDigest,
                        salt: c.salt, siblings: c.siblings, dirs: c.dirs,
                        payloadHashB: c.payloadHashB, attesterIdB: c.attesterIdB, allowedMask: c.allowedMask, k: c.k,
                        schema: c.schema, openingA: c.openingA, openingB: c.openingB
                    })),
                    feeSponsor: sponsor?.sponsorSessionId ?? null
                },
                requestedBy: req.user?.id,
                grantId: req.agentGrant?.ID,
                commandVersion: 1,
                encryptCommand: true,
                command: {
                    op: 'fieldPredicateBatchWorkflow', validUntil: validUntilArg,
                    payloadHash: data.payloadHash!.toLowerCase(),
                    attesterId,
                    contractAddress: data.contractAddress!,
                    compiledArtifactRef: compiledRef,
                    contentRoot: data.contentRoot?.toLowerCase(), schemaId: data.schemaId?.toLowerCase(),
                    claims: rowedClaims.map(c => ({
                        predicateAttestationId: c.predicateAttestationId,
                        fieldKey: c.fieldKey, predicate: c.predicate, threshold: c.threshold,
                        opCode: c.opCode, unit: c.unit, value: c.value,
                        expectedDigest: c.expectedDigest,
                        setRoot: c.setRoot, valueDigest: c.valueDigest,
                        setSiblings: c.setSiblings, setDirs: c.setDirs,
                        salt: c.salt, siblings: c.siblings, dirs: c.dirs,
                        payloadHashB: c.payloadHashB, attesterIdB: c.attesterIdB, allowedMask: c.allowedMask, k: c.k,
                        schema: c.schema, openingA: c.openingA, openingB: c.openingB
                    })),
                    sponsorSessionId: sponsor?.sponsorSessionId
                }
            });

            // A repeated request reuses the first job. Delete the rows made for this
            // request and return the rows of the first one.
            if (job.deduplicated) {
                await db.run(DELETE.from(PredicateAttestations).where({ ID: { in: rowedClaims.map(c => c.predicateAttestationId) } }));
            }
            const stableClaims = job.deduplicated
                ? ((job.originalRequest as any)?.claims ?? publicClaims)
                : publicClaims;
            return {
                jobId: job.jobId, status: job.status,
                claims: JSON.stringify(stableClaims),
                droppedDuplicates
            };
        });
    });

    srv.on(verifyPredicateAttestation, async (req) => {
        const { predicateAttestationId } = req.data;
        if (!predicateAttestationId) return req.reject(400, 'predicateAttestationId is required');

        const row: any = await db.run(
            SELECT.one.from(PredicateAttestations).where({ ID: predicateAttestationId })
        );
        if (!row) return req.reject(404, `PredicateAttestation ${predicateAttestationId} not found`);

        const provenOk = Boolean(row.provenTxHash);
        // Inclusion in a block is only reported. The verdict comes from the live state,
        // because a claim can expire or be removed after it landed.
        let included = false;
        if (provenOk) {
            const txRow: Transaction | undefined = await db.run(
                SELECT.one.from(Transactions).columns('ID', 'hash').where({ hash: row.provenTxHash })
            );
            if (txRow?.ID) {
                const result: any = await db.run(
                    SELECT.one.from(TransactionResults).columns('status', 'outcomeSource').where({ transaction_ID: txRow.ID })
                );
                included = result?.status === 'SUCCESS'
                    && result?.outcomeSource === 'substrate-system-events';
            }
        }

        const rowNetwork = row.network && (VALID_NIGHTGATE_NETWORKS as readonly string[]).includes(row.network)
            ? row.network as NightgateNetwork
            : undefined;
        let stateChecked = false;
        let current = false;
        if (liveProviderConfigured(rowNetwork) && row.contractAddress && row.payloadHash) {
            stateChecked = true;
            current = await verifyPredicateViaState(row);
        }

        return {
            verified: stateChecked && current,
            included,
            stateChecked,
            predicate: row.predicate ?? '',
            threshold: row.threshold ?? 0,
            unit: row.unit ?? '',
            expectedDigest: row.expectedDigest ?? '',
            setRoot: row.setRoot ?? '',
            payloadHashB: row.payloadHashB ?? '',
            // Some database drivers return Integer64 columns as strings.
            allowedMask: row.allowedMask === null || row.allowedMask === undefined ? null : coerceMask(row.allowedMask),
            provenTxHash: row.provenTxHash ?? '',
            provenAt: row.provenAt ?? null
        };
    });
}
