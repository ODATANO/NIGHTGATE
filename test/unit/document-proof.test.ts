/**
 * The document-proof handlers:
 *   - prepareDocumentProof validation ladder + response shape
 *   - prepareMembershipSet
 *   - attestAgentOutput: envelope canonical form, payload hash, delegation
 *     to anchorDocument, defaults, validation ladder
 *
 * Pure circuits are faked with a deterministic stand-in (sha256 over tagged
 * concatenations); the builders themselves are the kit's.
 */

vi.mock('@sap/cds', () => {
    const cds: any = {
        env: { requires: { nightgate: {} } },
        log: vi.fn(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }))
    };
    cds.default = cds;
    return cds;
});

import { sha256 } from '@noble/hashes/sha256';
import {
    canonicalize,
    blake2b256Hex,
    registerDocumentProofHandlers,
    PureCircuitsUnavailableError,
    MAX_PROOF_FIELDS,
    type PureCircuits
} from '../../srv/submission/document-proof';

/** Deterministic fake pure circuits: tagged sha256 concatenations. */
const fakeEmptyLeafKey = new Uint8Array(32);
fakeEmptyLeafKey.set(new TextEncoder().encode('nightgate/empty-leaf/v2'));
const fakePure: PureCircuits = {
    leafHash: (k, v, s) => sha256(Buffer.concat([Buffer.from('leaf'), Buffer.from(k), Buffer.from(v.toString()), Buffer.from(s)])),
    nodeHash: (l, r) => sha256(Buffer.concat([Buffer.from('node'), Buffer.from(l), Buffer.from(r)])),
    bytesLeafHash: (k, d, s) => sha256(Buffer.concat([Buffer.from('bytesleaf'), Buffer.from(k), Buffer.from(d), Buffer.from(s)])),
    absentLeafHash: (k, s) => sha256(Buffer.concat([Buffer.from('absentleaf'), Buffer.from(k), Buffer.from(s)])),
    setLeafHash: (d) => sha256(Buffer.concat([Buffer.from('setleaf'), Buffer.from(d)])),
    descriptorLeafHash: (k, kind, scale) => sha256(Buffer.concat([Buffer.from('descleaf'), Buffer.from(k), Buffer.from(`${kind}|${scale}`)])),
    slotSalt: (seed, i) => sha256(Buffer.concat([Buffer.from('slotsalt'), Buffer.from(seed), Buffer.from(i.toString())])),
    emptyLeafKey: () => fakeEmptyLeafKey
};

function refold(leafHex: string, siblings: string[], dirs: boolean[]): string {
    let node = Buffer.from(leafHex, 'hex') as Uint8Array;
    for (let d = 0; d < siblings.length; d++) {
        const sib = Buffer.from(siblings[d], 'hex');
        node = dirs[d] ? fakePure.nodeHash(node, sib) : fakePure.nodeHash(sib, node);
    }
    return Buffer.from(node).toString('hex');
}

let __ipCounter = 0;
function makeReq(data: Record<string, unknown>, opts: { user?: any } = {}) {
    __ipCounter += 1;
    return {
        data,
        user: 'user' in opts ? opts.user : { id: 'user-1' },
        reject: vi.fn((code: number, message: string) => ({ __rejected: true, code, message })),
        _: { req: { ip: `172.18.${(__ipCounter >> 8) & 0xff}.${__ipCounter & 0xff}` } }
    } as any;
}

describe('prepareDocumentProof handler', () => {
    const handlers: Record<string, Function> = {};
    const srv = {
        on(event: string, h: Function) { handlers[event] = h; },
        send: vi.fn()
    } as any;
    const loadPure = vi.fn(async () => fakePure);

    beforeEach(() => {
        vi.clearAllMocks();
        Object.keys(handlers).forEach(k => delete handlers[k]);
        registerDocumentProofHandlers(srv, { loadPure });
    });

    const VALID = {
        documentJson: JSON.stringify({ price: 10, days: 30 }),
        proofFieldsJson: JSON.stringify([{ field: 'price' }, { field: 'days' }])
    };

    it('rejects 400 on missing or malformed inputs', async () => {
        for (const [data, msg] of [
            [{}, 'documentJson'],
            [{ documentJson: '{]' , proofFieldsJson: '[]' }, 'valid JSON'],
            [{ documentJson: '[1]', proofFieldsJson: '[{"field":"a"}]' }, 'JSON object'],
            [{ documentJson: '{}', proofFieldsJson: '[]' }, 'non-empty'],
            [{ documentJson: '{}', proofFieldsJson: JSON.stringify([{ field: 'a' }, { field: 'a' }]) }, 'duplicate'],
            [{ documentJson: '{}', proofFieldsJson: JSON.stringify([{ field: 'a', scale: 0 }]) }, 'scale'],
            [{ documentJson: '{}', proofFieldsJson: JSON.stringify([{ field: 'a', kind: 'hex' }]) }, "kind must be 'uint' or 'bytes'"],
            [{ documentJson: '{}', proofFieldsJson: JSON.stringify([{ field: 'a', kind: 'bytes', scale: 100 }]) }, "not applicable to kind 'bytes'"],
            [{ documentJson: '{"a":7}', proofFieldsJson: JSON.stringify([{ field: 'a', kind: 'bytes' }]) }, 'requires a string'],
            [{ documentJson: '{"a":-1}', proofFieldsJson: JSON.stringify([{ field: 'a' }]) }, 'non-negative']
        ] as const) {
            const req = makeReq(data as any);
            await handlers.prepareDocumentProof(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining(msg));
        }
    });

    it('rejects 400 on more than 16 proof fields', async () => {
        const many = Array.from({ length: MAX_PROOF_FIELDS + 1 }, (_, i) => ({ field: `f${i}` }));
        const req = makeReq({ documentJson: '{}', proofFieldsJson: JSON.stringify(many) });
        await handlers.prepareDocumentProof(req);
        expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining('16'));
    });

    it('rejects 404 when the artifact is unknown or exports no pure circuits', async () => {
        loadPure.mockRejectedValueOnce(new PureCircuitsUnavailableError("contract 'nope' is not registered"));
        const req = makeReq({ ...VALID, compiledArtifactRef: 'nope' });
        await handlers.prepareDocumentProof(req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringContaining('nope'));
    });

    it('returns payload hash, canonical form, root and witness fields', async () => {
        const req = makeReq(VALID);
        const result = await handlers.prepareDocumentProof(req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.canonicalDocument).toBe(canonicalize({ price: 10, days: 30 }));
        expect(result.payloadHash).toBe(blake2b256Hex(result.canonicalDocument));
        expect(result.contentRoot).toMatch(/^[0-9a-f]{64}$/);
        const fields = JSON.parse(result.fields);
        expect(fields.map((f: any) => f.field)).toEqual(['price', 'days']);
        expect(JSON.parse(result.emptyFields)).toEqual([]);
        expect(loadPure).toHaveBeenCalledWith('attestation-vault');
    });
});

describe('prepareMembershipSet handler', () => {
    const handlers: Record<string, Function> = {};
    const srv = {
        on(event: string, h: Function) { handlers[event] = h; },
        send: vi.fn()
    } as any;
    const loadPure = vi.fn(async () => fakePure);

    beforeEach(() => {
        vi.clearAllMocks();
        Object.keys(handlers).forEach(k => delete handlers[k]);
        registerDocumentProofHandlers(srv, { loadPure });
    });

    const LIST = JSON.stringify(['EEA', 'CH', 'NO']);

    it('rejects 400 on malformed inputs', async () => {
        for (const [data, msg] of [
            [{}, 'allowedValuesJson'],
            [{ allowedValuesJson: '{]' }, 'valid JSON'],
            [{ allowedValuesJson: '[]' }, 'non-empty'],
            [{ allowedValuesJson: '[1]' }, 'non-empty strings'],
            [{ allowedValuesJson: LIST, value: 'EEA', valueDigest: 'a'.repeat(64) }, 'at most one'],
            [{ allowedValuesJson: LIST, valueDigest: 'zz' }, '64 hex'],
            [{ allowedValuesJson: LIST, value: 'DE' }, 'not in the allowed list'],
            [{ allowedValuesJson: JSON.stringify(Array.from({ length: 65 }, (_, i) => `v${i}`)) }, 'at most 64']
        ] as const) {
            const req = makeReq(data as any);
            await handlers.prepareMembershipSet(req);
            expect(req.reject).toHaveBeenCalledWith(expect.any(Number), expect.stringContaining(msg));
            expect(req.reject.mock.calls[0][0]).toBe(400);
        }
    });

    it('returns just the canonical root without a member (verifier lane)', async () => {
        const req = makeReq({ allowedValuesJson: LIST });
        const result = await handlers.prepareMembershipSet(req);
        expect(req.reject).not.toHaveBeenCalled();
        expect(result.setRoot).toMatch(/^[0-9a-f]{64}$/);
        expect(result.memberCount).toBe(3);
        expect(result.setSiblingsJson).toBeUndefined();
    });

    it('the root is canonical: order and duplicates of the list do not matter', async () => {
        const a = await handlers.prepareMembershipSet(makeReq({ allowedValuesJson: LIST }));
        const b = await handlers.prepareMembershipSet(makeReq({ allowedValuesJson: JSON.stringify(['NO', 'EEA', 'CH', 'EEA']) }));
        expect(b.setRoot).toBe(a.setRoot);
        expect(b.memberCount).toBe(3);
    });

    it('returns a refoldable inclusion path for a member (by value and by digest)', async () => {
        const byValue = await handlers.prepareMembershipSet(makeReq({ allowedValuesJson: LIST, value: 'CH' }));
        const byDigest = await handlers.prepareMembershipSet(makeReq({ allowedValuesJson: LIST, valueDigest: blake2b256Hex('CH') }));
        for (const result of [byValue, byDigest]) {
            const siblings = JSON.parse(result.setSiblingsJson);
            const dirs = JSON.parse(result.setDirsJson);
            expect(siblings).toHaveLength(6);
            expect(dirs).toHaveLength(6);
            const leaf = Buffer.from(fakePure.setLeafHash(Buffer.from(blake2b256Hex('CH'), 'hex'))).toString('hex');
            expect(refold(leaf, siblings, dirs)).toBe(result.setRoot);
        }
        expect(byDigest.setRoot).toBe(byValue.setRoot);
    });

    it('rejects 404 when the artifact is unavailable', async () => {
        loadPure.mockRejectedValueOnce(new PureCircuitsUnavailableError("contract 'nope' is not registered"));
        const req = makeReq({ allowedValuesJson: LIST, compiledArtifactRef: 'nope' });
        await handlers.prepareMembershipSet(req);
        expect(req.reject).toHaveBeenCalledWith(404, expect.stringContaining('nope'));
    });
});

describe('attestAgentOutput handler', () => {
    const handlers: Record<string, Function> = {};
    const sendSpy = vi.fn();
    const findSpy = vi.fn();
    const srv = {
        on(event: string, h: Function) { handlers[event] = h; },
        send: sendSpy
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        Object.keys(handlers).forEach(k => delete handlers[k]);
        registerDocumentProofHandlers(srv, { loadPure: vi.fn(), findProducedAt: findSpy });
        sendSpy.mockResolvedValue({ jobId: 'job-1', status: 'pending', documentId: 'doc-1' });
    });

    const VALID = {
        agentId: 'agent://doc-bot',
        inputHash: 'a'.repeat(64),
        outputHash: 'B'.repeat(64),
        sessionId: 'sess-1',
        contractAddress: '0xvault'
    };

    it('walks the validation ladder with 400s', async () => {
        for (const [data, msg] of [
            [{ ...VALID, agentId: undefined }, 'agentId'],
            [{ ...VALID, inputHash: 'zz' }, 'inputHash'],
            [{ ...VALID, outputHash: undefined }, 'outputHash'],
            [{ ...VALID, policyHash: '123' }, 'policyHash'],
            [{ ...VALID, sessionId: undefined }, 'sessionId'],
            [{ ...VALID, contractAddress: undefined }, 'contractAddress'],
            [{ ...VALID, producedAt: 'not-a-date' }, 'producedAt']
        ] as const) {
            const req = makeReq(data as any);
            await handlers.attestAgentOutput(req);
            expect(req.reject).toHaveBeenCalledWith(400, expect.stringContaining(msg));
        }
        expect(sendSpy).not.toHaveBeenCalled();
    });

    it('anchors the canonical envelope through anchorDocument and returns its hash', async () => {
        const req = makeReq({ ...VALID, modelId: 'claude-fable-5', producedAt: '2026-08-07T10:00:00.000Z' });
        const result = await handlers.attestAgentOutput(req);
        expect(req.reject).not.toHaveBeenCalled();

        const envelope = JSON.parse(result.envelopeJson);
        expect(envelope).toEqual({
            v: 1,
            agentId: 'agent://doc-bot',
            inputHash: 'a'.repeat(64),
            outputHash: 'b'.repeat(64), // lowercased
            producedAt: '2026-08-07T10:00:00.000Z',
            modelId: 'claude-fable-5'
        });
        expect(result.envelopeJson).toBe(canonicalize(envelope)); // canonical form
        expect(result.payloadHash).toBe(blake2b256Hex(result.envelopeJson));
        expect(result.jobId).toBe('job-1');
        expect(result.documentId).toBe('doc-1');

        const sent = sendSpy.mock.calls[0][0];
        expect(sent.event).toBe('anchorDocument');
        expect(sent.user).toEqual({ id: 'user-1' });
        expect(sent.data).toMatchObject({
            sha256: result.payloadHash,
            metadata: result.envelopeJson,
            storageRef: 'agent-output://agent://doc-bot',
            sessionId: 'sess-1',
            contractAddress: '0xvault',
            contentType: 'application/vnd.nightgate.agent-output.v1+json'
        });
    });

    it("records the anchor job under the caller's agent grant", async () => {
        const req = makeReq(VALID);
        (req as any).agentGrant = { ID: 'grant-9', sessionId: 'sess-1' };
        await handlers.attestAgentOutput(req);
        expect(sendSpy.mock.calls[0][0].agentGrant).toEqual({ ID: 'grant-9', sessionId: 'sess-1' });
    });

    it('defaults producedAt to now and keeps the envelope stable otherwise', async () => {
        const before = Date.now();
        const req = makeReq(VALID);
        const result = await handlers.attestAgentOutput(req);
        const envelope = JSON.parse(result.envelopeJson);
        expect(new Date(envelope.producedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(envelope).not.toHaveProperty('modelId');
        expect(envelope).not.toHaveProperty('policyHash');
    });

    it('a retry under the same key without producedAt reuses the recorded one', async () => {
        findSpy.mockResolvedValue('2026-09-26T08:00:00.000Z');
        const req = makeReq({ ...VALID, idempotencyKey: 'k-1' });
        const result = await handlers.attestAgentOutput(req);
        expect(findSpy).toHaveBeenCalledWith('sess-1', 'k-1', 'user-1');
        expect(JSON.parse(result.envelopeJson).producedAt).toBe('2026-09-26T08:00:00.000Z');
        expect(sendSpy.mock.calls[0][0].data.idempotencyKey).toBe('k-1');
    });

    it('looks up nothing without a key or with an explicit producedAt', async () => {
        await handlers.attestAgentOutput(makeReq(VALID));
        await handlers.attestAgentOutput(makeReq({ ...VALID, idempotencyKey: 'k-1', producedAt: '2026-08-07T10:00:00.000Z' }));
        expect(findSpy).not.toHaveBeenCalled();
    });

    it('a first call under a key falls back to now', async () => {
        findSpy.mockResolvedValue(null);
        const before = Date.now();
        const result = await handlers.attestAgentOutput(makeReq({ ...VALID, idempotencyKey: 'k-new' }));
        expect(new Date(JSON.parse(result.envelopeJson).producedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    });

    it('maps inner anchorDocument failures onto the outer request', async () => {
        sendSpy.mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { code: 429 }));
        const req = makeReq(VALID);
        await handlers.attestAgentOutput(req);
        expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
    });
});
