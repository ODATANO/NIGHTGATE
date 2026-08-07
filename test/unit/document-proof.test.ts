/**
 * Unit tests for srv/submission/document-proof.ts:
 *   - canonicalization + blake2b-256 hashing vectors (key order, nesting)
 *   - value scaling (default x1000, exact digit-string path, rejection ladder)
 *   - buildDocumentContentRoot: root stability, refoldable inclusion paths,
 *     empty leaves, order sensitivity
 *   - prepareDocumentProof handler validation ladder + response shape
 *   - attestAgentOutput: envelope canonical form, payload hash, delegation
 *     to anchorDocument, defaults, validation ladder
 *
 * Pure circuits are faked with a deterministic stand-in (sha256 over tagged
 * concatenations); the real leafHash/nodeHash parity is covered by the live
 * e2e path, exactly like the NIGHTPASS content-root builder.
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
import { blake2b } from '@noble/hashes/blake2b';
import { bytesToHex } from '@noble/hashes/utils';
import {
    sortKeys,
    canonicalize,
    blake2b256Hex,
    fieldKeyHex,
    scaleFieldValue,
    buildDocumentContentRoot,
    registerDocumentProofHandlers,
    PureCircuitsUnavailableError,
    MAX_PROOF_FIELDS,
    type PureCircuits
} from '../../srv/submission/document-proof';

/** Deterministic fake pure circuits: tagged sha256 concatenations. */
const fakePure: PureCircuits = {
    leafHash: (k, v) => sha256(Buffer.concat([Buffer.from('leaf'), Buffer.from(k), Buffer.from(v.toString())])),
    nodeHash: (l, r) => sha256(Buffer.concat([Buffer.from('node'), Buffer.from(l), Buffer.from(r)]))
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

describe('canonicalization + hashing', () => {
    it('hashes equal regardless of key order, including nested objects', () => {
        const a = { b: 1, a: { y: 2, x: [{ q: 1, p: 2 }] } };
        const b = { a: { x: [{ p: 2, q: 1 }], y: 2 }, b: 1 };
        expect(canonicalize(a)).toBe(canonicalize(b));
        expect(blake2b256Hex(canonicalize(a))).toBe(blake2b256Hex(canonicalize(b)));
    });

    it('sortKeys leaves arrays in order (order is data, not noise)', () => {
        expect(sortKeys({ a: [3, 1, 2] })).toEqual({ a: [3, 1, 2] });
    });

    it('blake2b256Hex matches an independent blake2b-256 computation', () => {
        const input = 'nightgate-vector';
        expect(blake2b256Hex(input)).toBe(bytesToHex(blake2b(Buffer.from(input, 'utf8'), { dkLen: 32 })));
    });

    it('fieldKeyHex is the blake2b-256 of the field path', () => {
        expect(fieldKeyHex('expiryDays')).toBe(blake2b256Hex('expiryDays'));
    });
});

describe('scaleFieldValue', () => {
    it('scales decimals by the given scale with rounding', () => {
        expect(scaleFieldValue(1234.5678, 1000, 'f')).toBe(1234568n);
        expect(scaleFieldValue('2.5', 100, 'f')).toBe(250n);
    });

    it('takes the exact BigInt path for digit-strings (beyond 2^53)', () => {
        expect(scaleFieldValue('18446744073709551615', 1, 'f')).toBe(18446744073709551615n);
    });

    it('trims strings and rejects blank ones instead of minting 0', () => {
        expect(scaleFieldValue(' 42 ', 1, 'f')).toBe(42n); // trimmed digit-string stays exact
        expect(() => scaleFieldValue('   ', 1000, 'f')).toThrow(/blank/);
        expect(() => scaleFieldValue('', 1000, 'f')).toThrow(/blank/);
    });

    it('rejects booleans instead of coercing them to 0/1', () => {
        expect(() => scaleFieldValue(true as any, 1000, 'f')).toThrow(/number or numeric string/);
        expect(() => scaleFieldValue(false as any, 1000, 'f')).toThrow(/number or numeric string/);
        expect(() => buildDocumentContentRoot({ active: true }, [{ field: 'active' }], fakePure))
            .toThrow(/number or numeric string/);
    });

    it('rejects negatives, non-numerics, Uint<64> overflow and unsafe scaling', () => {
        expect(() => scaleFieldValue(-1, 1000, 'f')).toThrow(/non-negative/);
        expect(() => scaleFieldValue('abc', 1000, 'f')).toThrow(/numeric/);
        expect(() => scaleFieldValue('18446744073709551615', 2, 'f')).toThrow(/Uint<64>/);
        expect(() => scaleFieldValue(Number.MAX_SAFE_INTEGER, 1000, 'f')).toThrow(/MAX_SAFE_INTEGER/);
    });
});

describe('buildDocumentContentRoot', () => {
    const doc = { price: 42.5, days: '30', note: 'not provable' };
    const specs = [{ field: 'price' }, { field: 'days', scale: 1 }];

    it('produces a stable root and refoldable inclusion paths', () => {
        const a = buildDocumentContentRoot(doc, specs, fakePure);
        const b = buildDocumentContentRoot(doc, specs, fakePure);
        expect(a.contentRoot).toBe(b.contentRoot);
        expect(a.fields).toHaveLength(2);
        expect(a.fields[0]).toMatchObject({ field: 'price', value: '42500', fieldKey: fieldKeyHex('price') });
        expect(a.fields[1]).toMatchObject({ field: 'days', value: '30' });
        for (const f of a.fields) {
            const leaf = Buffer.from(
                fakePure.leafHash(Buffer.from(f.fieldKey, 'hex'), BigInt(f.value))
            ).toString('hex');
            expect(refold(leaf, f.siblings, f.dirs)).toBe(a.contentRoot);
            expect(f.siblings).toHaveLength(4);
            expect(f.dirs).toHaveLength(4);
        }
    });

    it('is order-sensitive: the field list order is part of the tree identity', () => {
        const swapped = buildDocumentContentRoot(doc, [specs[1], specs[0]], fakePure);
        const original = buildDocumentContentRoot(doc, specs, fakePure);
        expect(swapped.contentRoot).not.toBe(original.contentRoot);
    });

    it('puts absent values on the empty leaf and reports them', () => {
        const result = buildDocumentContentRoot({ price: 1 }, [{ field: 'price' }, { field: 'missing' }], fakePure);
        expect(result.fields.map(f => f.field)).toEqual(['price']);
        expect(result.emptyFields).toEqual(['missing']);
    });

    it('treats whitespace-only strings as absent, not as value 0', () => {
        const result = buildDocumentContentRoot({ price: '   ' }, [{ field: 'price' }], fakePure);
        expect(result.fields).toEqual([]);
        expect(result.emptyFields).toEqual(['price']);
        const zero = buildDocumentContentRoot({ price: 0 }, [{ field: 'price' }], fakePure);
        expect(result.contentRoot).not.toBe(zero.contentRoot); // blank must not alias a real 0
    });

    it('resolves dot-paths into nested objects and arrays', () => {
        const nested = { invoice: { total: 99.5, lines: [{ amount: 12 }] } };
        const result = buildDocumentContentRoot(nested, [
            { field: 'invoice.total' }, { field: 'invoice.lines.0.amount' }
        ], fakePure);
        expect(result.fields.map(f => f.field)).toEqual(['invoice.total', 'invoice.lines.0.amount']);
        expect(result.fields[0].value).toBe('99500');
        expect(result.fields[1].value).toBe('12000');
        expect(result.emptyFields).toEqual([]);
    });

    it('prefers a literal top-level key over path descent', () => {
        const doc = { 'a.b': 7, a: { b: 1 } };
        const result = buildDocumentContentRoot(doc, [{ field: 'a.b' }], fakePure);
        expect(result.fields[0].value).toBe('7000');
    });

    it('throws when a path resolves to an object instead of a scalar', () => {
        expect(() => buildDocumentContentRoot({ invoice: { total: 1 } }, [{ field: 'invoice' }], fakePure))
            .toThrow(/object\/array/);
    });
});

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

describe('attestAgentOutput handler', () => {
    const handlers: Record<string, Function> = {};
    const sendSpy = vi.fn();
    const srv = {
        on(event: string, h: Function) { handlers[event] = h; },
        send: sendSpy
    } as any;

    beforeEach(() => {
        vi.clearAllMocks();
        Object.keys(handlers).forEach(k => delete handlers[k]);
        registerDocumentProofHandlers(srv, { loadPure: vi.fn() });
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

    it('defaults producedAt to now and keeps the envelope stable otherwise', async () => {
        const before = Date.now();
        const req = makeReq(VALID);
        const result = await handlers.attestAgentOutput(req);
        const envelope = JSON.parse(result.envelopeJson);
        expect(new Date(envelope.producedAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(envelope).not.toHaveProperty('modelId');
        expect(envelope).not.toHaveProperty('policyHash');
    });

    it('maps inner anchorDocument failures onto the outer request', async () => {
        sendSpy.mockRejectedValueOnce(Object.assign(new Error('Rate limited'), { code: 429 }));
        const req = makeReq(VALID);
        await handlers.attestAgentOutput(req);
        expect(req.reject).toHaveBeenCalledWith(429, expect.stringContaining('Rate limited'));
    });
});
