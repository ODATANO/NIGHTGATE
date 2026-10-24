/**
 * The proof actions take their inputs as typed OData parameters. CAP checks the
 * shapes before any handler runs: arrays, element types, enum values, ranges,
 * the hex format inside structured types and the parameter names themselves.
 */
import cds from '@sap/cds';

(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: { operator: { password: 'op-secret', roles: [] } }
};
const cap = cds.test(__dirname + '/../..');
const API = '/odata/v4/midnight';
const AUTH = { auth: { username: 'operator', password: 'op-secret' }, validateStatus: () => true };
const H = (c: string) => c.repeat(64);

describe('typed action parameters are validated by CAP', () => {
    test.each([
        ['prepareMembershipSet', { allowedValues: 'EEA,CH' }, 'ASSERT_ARRAY', 'allowedValues'],
        ['prepareMembershipSet', { allowedValues: ['EEA', 2] }, 'ASSERT_DATA_TYPE', 'allowedValues[1]'],
        ['prepareDocumentProof', { document: '{"a":1}', proofFields: [{ field: 'a' }] }, 'ASSERT_DATA_TYPE', 'document'],
        ['prepareDocumentProof', { document: { a: 1 }, proofFields: { field: 'a' } }, 'ASSERT_ARRAY', 'proofFields'],
        ['prepareDocumentProof', { document: { a: 1 }, proofFields: [{ field: 'a', kind: 'hex' }] }, 'ASSERT_ENUM', 'proofFields[0]/kind'],
        ['prepareDocumentProof', { document: { a: 1 }, proofFields: [{ field: 'a', scale: 0 }] }, 'ASSERT_RANGE', 'proofFields[0]/scale'],
        ['issueFieldPredicateAttestation', { dirs: ['true'] }, 'ASSERT_DATA_TYPE', 'dirs[0]'],
        ['issueFieldPredicateAttestation', { siblings: H('a') }, 'ASSERT_ARRAY', 'siblings'],
        ['issueFieldPredicateAttestationBatch', { claims: [{ predicate: 'between' }] }, 'ASSERT_ENUM', 'claims[0]/predicate'],
        ['issueFieldPredicateAttestationBatch', { claims: [{ predicate: 'documentDiff', schema: [{ fieldKey: 'zz', kind: 0, scale: '0' }] }] }, 'ASSERT_FORMAT', 'claims[0]/schema[0]/fieldKey'],
        ['issueDocumentIntegrityAttestation', { openingA: { saltSeed: 'zz', slots: [] } }, 'ASSERT_FORMAT', 'openingA/saltSeed'],
        ['issueDocumentIntegrityAttestation', { schema: [{ fieldKey: H('1'), kind: 7, scale: '0' }] }, 'ASSERT_RANGE', 'schema[0]/kind'],
        ['issueFieldPredicateAttestation', { predicate: 'between' }, 'ASSERT_ENUM', 'predicate'],
        ['purgeExpired', { kind: 'grant' }, 'ASSERT_ENUM', 'kind'],
        ['postSwapOffer', { offer: 'x', tags: 'cert' }, 'ASSERT_ARRAY', 'tags'],
        ['deployContract', { compiledArtifactRef: 'counter', initialPrivateState: '{}' }, 'ASSERT_DATA_TYPE', 'initialPrivateState']
    ])('%s %o answers 400 %s on %s', async (action, body, code, target) => {
        const r = await cap.axios.post(`${API}/${action}`, body, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.code).toBe(code);
        expect(r.data.error.target).toBe(target);
    });

    test('a function parameter outside its enum is refused', async () => {
        const r = await cap.axios.get(`${API}/verifyPredicateState(contractAddress='0xVAULT',attesterId='${H('a')}',payloadHash='${H('b')}',predicate='between')`, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.code).toBe('ASSERT_ENUM');
        expect(r.data.error.target).toBe('predicate');
    });

    test('a parameter name of the former JSON-string API is refused', async () => {
        const r = await cap.axios.post(`${API}/prepareMembershipSet`, { allowedValuesJson: '["EEA"]' }, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.message).toMatch(/"allowedValuesJson" does not exist/);
    });

    test('the hex format of a plain array is left to the handler', async () => {
        // CAP does not apply @assert.format to the items of `array of Hex64`.
        const r = await cap.axios.post(`${API}/issueFieldPredicateAttestation`, {
            payloadHash: H('a'), fieldKey: H('b'), value: '1', fieldSalt: H('c'), threshold: 5, predicate: 'lessOrEqual',
            siblings: [H('1'), H('2'), H('3'), 'short'], dirs: [true, false, true, false],
            sessionId: '00000000-0000-4000-8000-000000000001', contractAddress: '0xVAULT'
        }, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.message).toMatch(/each siblings entry must be 64 hex/);
    });
});
