// Actions that prove facts about document fields, and comparisons between two documents.
// SPDX-License-Identifier: Apache-2.0
import cds from '@sap/cds';
import { type NightgateNetwork, VALID_NIGHTGATE_NETWORKS } from '../../utils/nightgate-config';
import { ensureNetworkId } from '../../midnight/providers';
import { startJob } from '../background-jobs';
import { vaultRef, UINT64_MAX, vaultDims, parsePredicate, coerceMask, liveProviderConfigured } from '../verify-state';
import { blake2b256Hex, PureCircuitsUnavailableError } from '../document-proof';
import { membershipPathFor, SET_DEPTH } from '../set-root';
import { PredicateAttestations, type PredicateAttestation } from '#cds-models/midnight';
import { startJobWithRows, readUnsignedArg, VALUE_EXCEEDS, THRESHOLD_EXCEEDS, parseValidUntil, SchemaSlotWire, OpeningWire, parseInclusionPath, inclusionPathOrThrow, type InclusionPath, validateSchemaSlots, validateOpening, isVacuousMask, INT64_MAX, parseDocPairInputs, facadeConfigFromEnv, recordedNetworkId, artifactDigestOrNull, rejectIfMainnetBlocked, runSubmission, landedOnChain } from './common';
import type { SubmissionContext } from './context';
import { HEX64_ANY_CASE_RE } from '../../utils/hex-patterns';
import { issueDocumentDiffAttestation, issueDocumentIntegrityAttestation, issueFieldEqualityAttestation, issueFieldMembershipAttestation, issueFieldPredicateAttestation, issueFieldPredicateAttestationBatch, verifyPredicateAttestation, type IssuedClaim } from '#cds-models/NightgateService';
import { int64Value } from '../../utils/numbers';
import { checkRateClass } from '../../utils/rate-classes';

const { INSERT, SELECT } = cds.ql;

export function registerPredicateActions(ctx: Pick<SubmissionContext, 'srv' | 'db' | 'walletFactory' | 'contractResolver' | 'pureCircuitsLoader' | 'verifyPredicateViaState' | 'resolveAttester' | 'resolveSponsorForRequest'>): void {
    const { srv, db, walletFactory, contractResolver, pureCircuitsLoader, verifyPredicateViaState, resolveAttester, resolveSponsorForRequest } = ctx;

    srv.on(issueFieldPredicateAttestation, async (req) => {
        const data = req.data;

        const { validUntil: validUntilArg, error: validUntilError } = parseValidUntil(data.validUntil);
        if (validUntilError) return req.reject(400, validUntilError);

        if (!data.payloadHash) return req.reject(400, 'payloadHash is required');
        if (!data.fieldKey) return req.reject(400, 'fieldKey is required');
        const valueBig = readUnsignedArg(data.value, 'value', UINT64_MAX, VALUE_EXCEEDS);
        if (typeof valueBig === 'string') return req.reject(400, valueBig);
        if (!data.fieldSalt) {
            return req.reject(400, 'fieldSalt is required (v4 salted leaves; prepareDocumentProof returns it per field)');
        }

        const thresholdBig = readUnsignedArg(data.threshold, 'threshold', INT64_MAX, THRESHOLD_EXCEEDS);
        if (typeof thresholdBig === 'string') return req.reject(400, thresholdBig);

        const parsedPredicate = parsePredicate(data.predicate);
        if (!parsedPredicate || parsedPredicate.kind !== 'numeric') {
            return req.reject(400, "predicate must be 'lessOrEqual' or 'greaterOrEqual' (use issueFieldEqualityAttestation / issueFieldMembershipAttestation for the bytes kinds)");
        }
        const op = parsedPredicate.opCode!;

        const { depth } = vaultDims(data.compiledArtifactRef);
        const path = parseInclusionPath(req, data.siblings, data.dirs, depth, { siblings: 'siblings', dirs: 'dirs' });
        if (!path) return;
        const { siblings, dirs: dirsBool } = path;

        if (data.contentRoot && !data.schemaId) {
            return req.reject(400, 'schemaId is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        const contractAddress = data.contractAddress;
        if (!contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = vaultRef(data.compiledArtifactRef);

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;

        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        const insertRows = INSERT.into(PredicateAttestations).entries({
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
        });

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJobWithRows(db, PredicateAttestations, [predicateAttestationId], insertRows, () => startJob({
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
                    contentRoot: data.contentRoot, schemaId: data.schemaId, siblings, dirs: dirsBool,
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
            }));

            const stablePredicateId = job.originalRequest?.predicateAttestationId ?? predicateAttestationId;
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

        const path = parseInclusionPath(req, data.siblings, data.dirs, vaultDims(data.compiledArtifactRef).depth, { siblings: 'siblings', dirs: 'dirs' });
        if (!path) return;
        if (data.contentRoot && !data.schemaId) {
            return req.reject(400, 'schemaId is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = vaultRef(data.compiledArtifactRef);

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;

        // No operator or threshold here. The claim is the expected digest itself.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        const insertRows = INSERT.into(PredicateAttestations).entries({
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
        });

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJobWithRows(db, PredicateAttestations, [predicateAttestationId], insertRows, () => startJob({
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
                    siblings: path.siblings, dirs: path.dirs,
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
            }));

            const stablePredicateId = job.originalRequest?.predicateAttestationId ?? predicateAttestationId;
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

        const hasList = Array.isArray(data.allowedValues) && data.allowedValues.length > 0;
        const hasSetPath = !!(data.setRoot || data.setSiblings || data.setDirs);
        if (hasList && hasSetPath) {
            return req.reject(400, 'pass either allowedValues or setRoot + setSiblings + setDirs, not both');
        }
        if (!hasList && !(data.setRoot && data.setSiblings && data.setDirs)) {
            return req.reject(400, 'allowedValues or setRoot + setSiblings + setDirs is required');
        }

        const path = parseInclusionPath(req, data.siblings, data.dirs, vaultDims(data.compiledArtifactRef).depth, { siblings: 'siblings', dirs: 'dirs' });
        if (!path) return;
        if (data.contentRoot && !data.schemaId) {
            return req.reject(400, 'schemaId is required when contentRoot is supplied (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = vaultRef(data.compiledArtifactRef);

        // Build the set before the rate limit check, so a value missing from the list costs no budget.
        let setRoot: string;
        let setSiblings: string[];
        let setDirs: boolean[];
        if (hasList) {
            const allowed = data.allowedValues!;
            if (allowed.some(v => typeof v !== 'string' || v.length === 0)) {
                return req.reject(400, 'allowedValues entries must be non-empty strings');
            }
            // Every entry is hashed before duplicates are removed, so limit the raw list size.
            if (allowed.length > 1024) {
                return req.reject(400, 'allowedValues supports at most 1024 raw entries (64 distinct values)');
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
                member = membershipPathFor(allowed, valueDigest, pure);
            } catch (err) {
                return req.reject(400, (err as Error).message);
            }
            if (!member) return req.reject(400, 'value is not in the allowed list');
            setRoot = member.setRoot;
            setSiblings = member.setSiblings;
            setDirs = member.setDirs;
        } else {
            const setPath = parseInclusionPath(req, data.setSiblings, data.setDirs, SET_DEPTH, { siblings: 'setSiblings', dirs: 'setDirs' });
            if (!setPath) return;
            setRoot = data.setRoot!.toLowerCase();
            setSiblings = setPath.siblings;
            setDirs = setPath.dirs;
        }

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;

        // Only the set root is public. The value digest and the paths stay private proof inputs.
        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        const insertRows = INSERT.into(PredicateAttestations).entries({
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
        });

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJobWithRows(db, PredicateAttestations, [predicateAttestationId], insertRows, () => startJob({
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
                    siblings: path.siblings, dirs: path.dirs,
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
            }));

            const stablePredicateId = job.originalRequest?.predicateAttestationId ?? predicateAttestationId;
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
        const docPair = parseDocPairInputs(req, data.schema, data.openingA, data.openingB, intWidth);
        if (!docPair) return;
        if (isVacuousMask(allowedMask, docPair.schema)) {
            return req.reject(400, 'allowedMask frees every real (non-padding) schema slot; the claim would be vacuous');
        }
        if ((data.contentRootA || data.contentRootB) && !data.schemaId) {
            return req.reject(400, 'schemaId is required when anchoring a content root (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = vaultRef(data.compiledArtifactRef);

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;

        // Document A is stored in the payloadHash column.
        const attesterIdA = await resolveAttester(req, data.sessionId, data.attesterIdA, Boolean(data.contentRootA));
        if (!attesterIdA) return;
        const attesterIdB = await resolveAttester(req, data.sessionId, data.attesterIdB ?? attesterIdA, Boolean(data.contentRootB));
        if (!attesterIdB) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        const insertRows = INSERT.into(PredicateAttestations).entries({
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
        });

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJobWithRows(db, PredicateAttestations, [predicateAttestationId], insertRows, () => startJob({
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
            }));

            const stablePredicateId = job.originalRequest?.predicateAttestationId ?? predicateAttestationId;
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
        const docPair = parseDocPairInputs(req, data.schema, data.openingA, data.openingB, diffWidth);
        if (!docPair) return;
        if ((data.contentRootA || data.contentRootB) && !data.schemaId) {
            return req.reject(400, 'schemaId is required when anchoring a content root (anchorContentRoot anchors both)');
        }
        if (!data.sessionId) return req.reject(400, 'sessionId is required');
        if (!data.contractAddress) return req.reject(400, 'contractAddress is required');

        const compiledRef = vaultRef(data.compiledArtifactRef);

        if (rejectIfMainnetBlocked(req)) return;
        if (!checkRateClass('prove', data.sessionId, req)) return;

        // k is stored in the threshold column.
        const attesterIdA = await resolveAttester(req, data.sessionId, data.attesterIdA, Boolean(data.contentRootA));
        if (!attesterIdA) return;
        const attesterIdB = await resolveAttester(req, data.sessionId, data.attesterIdB ?? attesterIdA, Boolean(data.contentRootB));
        if (!attesterIdB) return;
        const predicateAttestationId = cds.utils.uuid();
        const insertedAt = new Date().toISOString();
        const insertRows = INSERT.into(PredicateAttestations).entries({
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
        });

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            const job = await startJobWithRows(db, PredicateAttestations, [predicateAttestationId], insertRows, () => startJob({
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
            }));

            const stablePredicateId = job.originalRequest?.predicateAttestationId ?? predicateAttestationId;
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
        if (!data.claims?.length) return req.reject(400, 'claims is required');

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
        const parsePath = (sibs: unknown, ds: unknown, i: number, depth: number, sibName: string, dirName: string): InclusionPath =>
            inclusionPathOrThrow(sibs, ds, depth, { siblings: `claims[${i}].${sibName}`, dirs: `claims[${i}].${dirName}` });
        const { width: batchWidth, depth: batchDepth, maxMask: batchMaxMask } = vaultDims(data.compiledArtifactRef);
        let claims: BatchClaim[];
        try {
            const v = data.claims;
            if (v.length > maxClaims) {
                return req.reject(400, `claims supports at most ${maxClaims} entries per batch` + (data.contentRoot ? ' (the contentRoot anchor occupies one of the 8 call slots)' : ''));
            }
            claims = v.map((entry, i): BatchClaim => {
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
                        const allowedMask = entry.allowedMask === undefined || entry.allowedMask === null ? null : coerceMask(entry.allowedMask);
                        if (allowedMask === null || allowedMask < 0 || allowedMask > batchMaxMask) {
                            throw new Error(`claims[${i}].allowedMask must be an integer in 0..${batchMaxMask}`);
                        }
                        if (allowedMask === batchMaxMask) {
                            throw new Error(`claims[${i}].allowedMask ${batchMaxMask} permits every slot to differ; the claim would be vacuous`);
                        }
                        if (isVacuousMask(allowedMask, schema)) {
                            throw new Error(`claims[${i}].allowedMask frees every real (non-padding) schema slot; the claim would be vacuous`);
                        }
                        return {
                            predicate: 'documentIntegrity', payloadHashB, attesterIdB, allowedMask,
                            schema, openingA, openingB
                        };
                    }
                    const k = entry.k;
                    if (k === null || k === undefined || !Number.isInteger(k) || k < 1 || k > batchWidth) {
                        throw new Error(`claims[${i}].k must be an integer in 1..${batchWidth}`);
                    }
                    return {
                        predicate: 'documentDiff', payloadHashB, attesterIdB, k,
                        schema, openingA, openingB
                    };
                }

                if (typeof entry.fieldKey !== 'string' || !HEX64_ANY_CASE_RE.test(entry.fieldKey)) {
                    throw new Error(`claims[${i}].fieldKey must be 64 hex chars (32 bytes)`);
                }
                const contentPath = parsePath(entry.siblings, entry.dirs, i, batchDepth, 'siblings', 'dirs');
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
                    const expectedValue = typeof entry.expectedValue === 'string' && entry.expectedValue.length > 0 ? entry.expectedValue : null;
                    const expectedDigest = typeof entry.expectedDigest === 'string' && entry.expectedDigest.length > 0 ? entry.expectedDigest : null;
                    if ((expectedValue === null) === (expectedDigest === null)) throw new Error(`claims[${i}]: pass exactly one of expectedValue / expectedDigest`);
                    if (expectedDigest !== null && !HEX64_ANY_CASE_RE.test(expectedDigest)) throw new Error(`claims[${i}].expectedDigest must be 64 hex chars (32 bytes)`);
                    return { ...base, expectedDigest: expectedDigest !== null ? expectedDigest.toLowerCase() : blake2b256Hex(expectedValue!) };
                }

                if (parsed.kind === 'membership') {
                    const value = typeof entry.value === 'string' && entry.value.length > 0 ? entry.value : null;
                    const digest = typeof entry.valueDigest === 'string' && entry.valueDigest.length > 0 ? entry.valueDigest : null;
                    if ((value === null) === (digest === null)) throw new Error(`claims[${i}]: pass exactly one of value / valueDigest`);
                    if (digest !== null && !HEX64_ANY_CASE_RE.test(digest)) throw new Error(`claims[${i}].valueDigest must be 64 hex chars (32 bytes)`);
                    const valueDigest = digest !== null ? digest.toLowerCase() : blake2b256Hex(value!);
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
                    const setPath = parsePath(entry.setSiblings, entry.setDirs, i, SET_DEPTH, 'setSiblings', 'setDirs');
                    return { ...base, valueDigest, setRoot: entry.setRoot.toLowerCase(), setSiblings: setPath.siblings, setDirs: setPath.dirs };
                }

                const valueBig = readUnsignedArg(entry.value, `claims[${i}].value`, UINT64_MAX, VALUE_EXCEEDS);
                if (typeof valueBig === 'string') throw new Error(valueBig);
                const thresholdBig = readUnsignedArg(entry.threshold, `claims[${i}].threshold`, INT64_MAX, THRESHOLD_EXCEEDS);
                if (typeof thresholdBig === 'string') throw new Error(thresholdBig);
                return { ...base, value: valueBig.toString(), threshold: thresholdBig.toString(), opCode: parsed.opCode! };
            });
        } catch (e: unknown) {
            return req.reject(400, e instanceof Error && /^claims\[/.test(e.message) ? e.message : 'claims entries must match the predicate\'s inputs');
        }

        const compiledRef = vaultRef(data.compiledArtifactRef);

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
        if (!checkRateClass('prove', data.sessionId, req, uniqueClaims.length)) return;

        const attesterId = await resolveAttester(req, data.sessionId, data.attesterId, Boolean(data.contentRoot));
        if (!attesterId) return;
        const insertedAt = new Date().toISOString();
        const rowedClaims = uniqueClaims.map(c => ({ ...c, predicateAttestationId: cds.utils.uuid() }));
        const insertRows = INSERT.into(PredicateAttestations).entries(rowedClaims.map(c => ({
            ID: c.predicateAttestationId,
            payloadHash: data.payloadHash!.toLowerCase(),
            attesterId,
            contractAddress,
            predicate: c.predicate,
            op: c.opCode ?? null,
            threshold: int64Value(c.predicate === 'documentDiff' ? c.k : c.threshold),
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
        })));

        return runSubmission(req, async () => {
            const facadeCfg = facadeConfigFromEnv();
            await ensureNetworkId(facadeCfg.networkId);
            await contractResolver(compiledRef);
            await walletFactory({ sessionId: data.sessionId!, db, facadeConfig: facadeCfg, expectedUserId: req.user?.id });
            const sponsor = await resolveSponsorForRequest(req, data.sponsorSessionId);

            // Each claim lists every field; the ones its predicate does not use are null.
            const publicClaims = rowedClaims.map((c): IssuedClaim => {
                const is = (p: string) => c.predicate === p;
                const numeric = !['bytesEquality', 'setMembership', 'documentIntegrity', 'documentDiff'].includes(c.predicate);
                return {
                    predicateAttestationId: c.predicateAttestationId, fieldKey: c.fieldKey ?? null, predicate: c.predicate,
                    threshold: numeric ? int64Value(c.threshold) : null, unit: numeric ? c.unit ?? null : null,
                    expectedDigest: is('bytesEquality') ? c.expectedDigest ?? null : null,
                    setRoot: is('setMembership') ? c.setRoot ?? null : null,
                    payloadHashB: is('documentIntegrity') || is('documentDiff') ? c.payloadHashB ?? null : null,
                    allowedMask: is('documentIntegrity') ? c.allowedMask ?? null : null,
                    k: is('documentDiff') ? c.k ?? null : null
                };
            });
            const job = await startJobWithRows(db, PredicateAttestations, rowedClaims.map(c => c.predicateAttestationId), insertRows, () => startJob({
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
            }));

            // A repeated request reuses the first job and returns its rows.
            const stableClaims = job.deduplicated
                ? (job.originalRequest?.claims ?? publicClaims)
                : publicClaims;
            return {
                jobId: job.jobId, status: job.status,
                claims: stableClaims,
                droppedDuplicates
            };
        });
    });

    srv.on(verifyPredicateAttestation, async (req) => {
        const { predicateAttestationId } = req.data;
        if (!predicateAttestationId) return req.reject(400, 'predicateAttestationId is required');
        if (!checkRateClass('read', 'read', req)) return;

        const row: PredicateAttestation | undefined = await db.run(
            SELECT.one.from(PredicateAttestations).where({ ID: predicateAttestationId })
        );
        if (!row) return req.reject(404, `PredicateAttestation ${predicateAttestationId} not found`);

        const provenOk = Boolean(row.provenTxHash);
        // Inclusion in a block is only reported. The verdict comes from the live state,
        // because a claim can expire or be removed after it landed.
        let included = false;
        if (provenOk) {
            included = await landedOnChain(db, row.provenTxHash);
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
