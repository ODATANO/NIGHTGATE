/**
 * The proof actions take their inputs as typed OData parameters. CAP checks the
 * shapes before any handler runs: arrays, element types, enum values, ranges,
 * the hex format inside structured types and the parameter names themselves.
 */
import cds from '@sap/cds';
import { bech32m } from '@scure/base';
import { VALID_NIGHTGATE_NETWORKS, VALID_GRANTEE_BINDINGS } from '../../srv/utils/nightgate-config';

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
        ['proveFieldPredicate', { dirs: ['true'] }, 'ASSERT_DATA_TYPE', 'dirs[0]'],
        ['proveFieldPredicate', { siblings: H('a') }, 'ASSERT_ARRAY', 'siblings'],
        ['proveClaims', { claims: [{ predicate: 'between' }] }, 'ASSERT_ENUM', 'claims[0]/predicate'],
        ['proveClaims', { claims: [{ predicate: 'documentDiff', schema: [{ fieldKey: 'zz', kind: 0, scale: '0' }] }] }, 'ASSERT_FORMAT', 'claims[0]/schema[0]/fieldKey'],
        ['proveDocumentIntegrity', { openingA: { saltSeed: 'zz', slots: [] } }, 'ASSERT_FORMAT', 'openingA/saltSeed'],
        ['proveDocumentIntegrity', { schema: [{ fieldKey: H('1'), kind: 7, scale: '0' }] }, 'ASSERT_RANGE', 'schema[0]/kind'],
        ['proveFieldPredicate', { predicate: 'between' }, 'ASSERT_ENUM', 'predicate'],
        ['purgeExpired', { kind: 'grant' }, 'ASSERT_ENUM', 'kind'],
        ['postSwapOffer', { offer: 'x', tags: 'cert' }, 'ASSERT_ARRAY', 'tags'],
        ['deployContract', { contractName: 'counter', initialPrivateState: '{}' }, 'ASSERT_DATA_TYPE', 'initialPrivateState']
    ])('%s %o answers 400 %s on %s', async (action, body, code, target) => {
        const r = await cap.axios.post(`${API}/${action}`, body, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.code).toBe(code);
        expect(r.data.error.target).toBe(target);
    });

    test.each([
        ['anchorDocument', { contentType: 'x'.repeat(101) }, 'contentType'],
        ['anchorDocument', { storageRef: 's3://' + 'x'.repeat(500) }, 'storageRef'],
        ['attestAgentOutput', { storageRef: 's3://' + 'x'.repeat(500) }, 'storageRef'],
        ['proveFieldPredicate', { unit: 'u'.repeat(51) }, 'unit'],
        ['proveClaims', { claims: [{ predicate: 'lessOrEqual', unit: 'u'.repeat(51) }] }, 'claims[0]/unit']
    ])('%s refuses a text longer than its column with 400 on %s', async (action, body, target) => {
        const r = await cap.axios.post(`${API}/${action}`, body, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.target).toBe(target);
    });

    test('a function parameter outside its enum is refused', async () => {
        const r = await cap.axios.get(`${API}/verifyPredicate(contractAddress='${H('d')}',attesterId='${H('a')}',payloadHash='${H('b')}',predicate='between')`, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.code).toBe('ASSERT_ENUM');
        expect(r.data.error.target).toBe('predicate');
    });

    test('a function parameter outside its range is refused', async () => {
        const r = await cap.axios.get(`${API}/verifyDisclosure(contractAddress='${H('d')}',attesterId='${H('a')}',payloadHash='${H('b')}',grantee='${H('c')}',minLevel=3)`, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.code).toBe('ASSERT_RANGE');
        expect(r.data.error.target).toBe('minLevel');
    });

    test('a parameter name of the former JSON-string API is refused', async () => {
        const r = await cap.axios.post(`${API}/prepareMembershipSet`, { allowedValuesJson: '["EEA"]' }, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.message).toMatch(/"allowedValuesJson" does not exist/);
    });

    const SESSION = '00000000-0000-4000-8000-000000000001';
    const address = (prefix: string, length: number): string =>
        bech32m.encode(prefix, bech32m.toWords(Uint8Array.from({ length }, (_, i) => (i * 37 + 5) & 255)), false);

    test.each([
        ['sendToken', { amount: 'abc' }, 'amount'],
        ['sendToken', { amount: '0x10' }, 'amount'],
        ['sendToken', { amount: ' 10' }, 'amount'],
        ['sponsorTransfer', { amount: '-1' }, 'amount'],
        ['mintFactoryToken', { amount: '1.5' }, 'amount'],
        ['burnFactoryToken', { amount: '1e3' }, 'amount'],
        ['createAgentGrant', { maxValuePerDay: [{ tokenType: H('a'), amount: 'many' }] }, 'maxValuePerDay[0]/amount'],
        ['sendToken', { receiverAddress: 'addr_test1qqqq' }, 'receiverAddress'],
        ['sendToken', { receiverAddress: address('mn_dust_preprod', 33) }, 'receiverAddress'],
        ['registerForDustGeneration', { dustReceiverAddress: address('mn_addr_preprod', 32) }, 'dustReceiverAddress']
    ])('%s %o answers 400 ASSERT_FORMAT on %s', async (action, body, target) => {
        const r = await cap.axios.post(`${API}/${action}`, body, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error).toMatchObject({ code: 'ASSERT_FORMAT', target });
    });

    test.each([
        ['an unshielded address of a test network', address('mn_addr_preprod', 32)],
        ['an unshielded address of mainnet', address('mn_addr', 32)],
        ['a shielded address of a test network', address('mn_shield-addr_preview', 64)],
        ['a shielded address of mainnet', address('mn_shield-addr', 64)]
    ])('sendToken takes %s and a decimal amount', async (_name, receiverAddress) => {
        const r = await cap.axios.post(`${API}/sendToken`, { sessionId: SESSION, receiverAddress, amount: '1000000' }, AUTH);
        expect(r.data.error?.code).not.toBe('ASSERT_FORMAT');
        expect(String(r.data.error?.message ?? '')).not.toMatch(/must start with/);
    });

    test('a DUST address in both spellings passes the type', async () => {
        for (const dustReceiverAddress of [address('mn_dust_preprod', 33), address('mn_dust', 33)]) {
            const r = await cap.axios.post(`${API}/registerForDustGeneration`, { sessionId: SESSION, dustReceiverAddress }, AUTH);
            expect(r.data.error?.code).not.toBe('ASSERT_FORMAT');
        }
    });

    test.each([
        [`listSwapOffers(status='closed')`, 'ASSERT_ENUM', 'status'],
        [`listSwapOffers(status='OPEN')`, 'ASSERT_ENUM', 'status'],
        [`verifyAttestation(contractAddress='${H('d')}',attesterId='${H('a')}',payloadHash='${H('b')}',network='moon')`, 'ASSERT_ENUM', 'network']
    ])('%s answers 400 %s on %s', async (call, code, target) => {
        const r = await cap.axios.get(`${API}/${call}`, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error).toMatchObject({ code, target });
    });

    test.each([
        ['grantDisclosure', { level: 3 }, 'level'],
        ['grantDisclosure', { level: -1 }, 'level'],
        ['registerDocument', { mode: 5 }, 'mode']
    ])('%s %o answers 400 ASSERT_RANGE on %s', async (action, body, target) => {
        const r = await cap.axios.post(`${API}/${action}`, body, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error).toMatchObject({ code: 'ASSERT_RANGE', target });
    });

    test.each(['open', 'filled', 'retired', 'expired', 'all'])('listSwapOffers takes the status %s', async (status) => {
        const r = await cap.axios.get(`${API}/listSwapOffers(status='${status}')`, AUTH);
        expect(r.status).toBe(200);
    });

    test('the value lists of the model match the lists the code checks against', () => {
        const values = (type: string): string[] => Object.values(((cds.model!.definitions as Record<string, any>)[type]?.enum ?? {}) as Record<string, { val?: string }>)
            .map((entry, i) => entry.val ?? Object.keys((cds.model!.definitions as Record<string, any>)[type].enum)[i]);
        expect(values('Network').sort()).toEqual([...VALID_NIGHTGATE_NETWORKS].sort());
        expect(values('GranteeBinding').sort()).toEqual([...VALID_GRANTEE_BINDINGS].sort());
        expect(values('ContentHashKind').sort()).toEqual(['blake2b-256', 'sha256']);
        expect(values('ReadinessPhase')).toEqual(['starting', 'warming', 'catching_up', 'ready', 'degraded', 'failed']);
        expect(values('SwapOfferFilter')).toEqual(['open', 'filled', 'retired', 'expired', 'all']);
    });

    test('no own state of the model is spelled with a hyphen or a capital', () => {
        const own = ['SyncStatus', 'PendingSubmissionStatus', 'BackgroundJobStatus', 'BackgroundJobChainStatus', 'SwapOfferStatus',
            'SwapOfferFilter', 'HolderGrantStatus', 'ReorgStatus', 'ReadinessPhase', 'ProvingMode', 'StateSource', 'ContractSource', 'PolicySource',
            'WorkerThread', 'TxType', 'PayloadDecodeState', 'GranteeBinding', 'Network'];
        for (const type of own) {
            const names = Object.keys(((cds.model!.definitions as Record<string, any>)[type]?.enum ?? {}));
            expect(names.length, type).toBeGreaterThan(0);
            expect(names.filter(name => !/^[a-z][a-z0-9_]*$/.test(name)), type).toEqual([]);
        }
    });

    test('a block height and a block time arrive as text, from a table and from a function', async () => {
        const db = await cds.connect.to('db');
        const now = new Date().toISOString();
        const blockId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into('midnight.Blocks').entries({
            ID: blockId, hash: H('7'), height: 4242, protocolVersion: 1, timestamp: 1700000000, createdAt: now, modifiedAt: now
        }));
        const jobId = cds.utils.uuid();
        await db.run(cds.ql.INSERT.into('midnight.BackgroundJobs').entries({
            ID: jobId, kind: 'sendToken', sessionId: 'int64-form', status: 'succeeded', requestedBy: 'operator', blockHeight: 4242, createdAt: now, modifiedAt: now
        }));
        const block = (await cap.axios.get(`${API}/Blocks?$filter=height eq 4242`, AUTH)).data.value[0];
        expect([block.height, block.timestamp, block.protocolVersion]).toEqual(['4242', '1700000000', 1]);
        const job = (await cap.axios.get(`${API}/getJobStatus(jobId='${jobId}')`, AUTH)).data;
        expect([job.blockHeight, job.attempt]).toEqual(['4242', 0]);
    });

    test('no height and no time of the model has 32 bit', () => {
        const narrow: string[] = [];
        const check = (owner: string, fields: Record<string, any> | undefined) => {
            for (const [name, field] of Object.entries(fields ?? {})) {
                if (/(height|^timestamp|^ctime)$/i.test(name) && field.type === 'cds.Integer') narrow.push(`${owner}.${name}`);
                check(`${owner}.${name}`, field.elements ?? field.items?.elements);
            }
        };
        for (const [name, definition] of Object.entries(cds.model!.definitions as Record<string, any>)) {
            check(name, definition.elements);
            const operations = { ...(definition.kind === 'action' || definition.kind === 'function' ? { [name]: definition } : {}), ...(definition.actions ?? {}) };
            for (const [op, operation] of Object.entries(operations as Record<string, any>)) {
                check(`${name}/${op}`, operation.params);
                check(`${name}/${op}`, operation.returns?.elements ?? operation.returns?.items?.elements);
            }
        }
        expect(narrow).toEqual([]);
    });

    // The runtime model keeps the annotations of a type, not its name.
    test('every amount and every address parameter of the model carries its format', () => {
        const amount = '^[0-9]+$';
        const untyped: string[] = [];
        const check = (owner: string, params: Record<string, Record<string, unknown>> | undefined) => {
            for (const [name, param] of Object.entries(params ?? {})) {
                const format = String(param['@assert.format'] ?? '');
                const isAmount = name === 'amount';
                const isAddress = /Address$/.test(name) && !/^(contract|registry)Address$/.test(name);
                if (isAmount && format !== amount) untyped.push(`${owner}.${name}`);
                if (isAddress && !format.startsWith('^mn_')) untyped.push(`${owner}.${name}`);
            }
        };
        let seen = 0;
        for (const [name, definition] of Object.entries(cds.model!.definitions as Record<string, any>)) {
            if (definition.kind === 'action' || definition.kind === 'function') { seen++; check(name, definition.params); }
            for (const [bound, operation] of Object.entries((definition.actions ?? {}) as Record<string, any>)) { seen++; check(`${name}.${bound}`, operation.params); }
        }
        expect(seen).toBeGreaterThan(70);
        expect(untyped).toEqual([]);
    });

    test('a threshold and a numeric value are decimal text: a JSON number and a text that is no decimal are refused', async () => {
        const body = (over: Record<string, unknown>) => ({
            payloadHash: H('a'), fieldKey: H('b'), value: '1', fieldSalt: H('c'), threshold: '5', predicate: 'lessOrEqual',
            siblings: [H('1'), H('2'), H('3'), H('4')], dirs: [true, false, true, false],
            sessionId: '00000000-0000-4000-8000-000000000001', contractAddress: H('d'), ...over
        });
        const refusal = async (over: Record<string, unknown>) => {
            const r = await cap.axios.post(`${API}/proveFieldPredicate`, body(over), AUTH);
            return [r.status, r.data.error?.code, r.data.error?.target];
        };
        expect(await refusal({ threshold: 5 })).toEqual([400, 'ASSERT_DATA_TYPE', 'threshold']);
        expect(await refusal({ threshold: '0x10' })).toEqual([400, 'ASSERT_FORMAT', 'threshold']);
        expect(await refusal({ threshold: '-5' })).toEqual([400, 'ASSERT_FORMAT', 'threshold']);
        expect(await refusal({ value: 1 })).toEqual([400, 'ASSERT_DATA_TYPE', 'value']);
        expect(await refusal({ value: '1.5' })).toEqual([400, 'ASSERT_FORMAT', 'value']);
    });

    test('a threshold goes up to 2^64-1, in an action and in a function URL', async () => {
        const fn = (threshold: string) => cap.axios.get(
            `${API}/verifyPredicate(contractAddress='${H('d')}',attesterId='${H('a')}',payloadHash='${H('b')}',fieldKey='${H('c')}',predicate='lessOrEqual',threshold=${threshold})`, AUTH);
        const above = await fn("'18446744073709551616'");
        expect([above.status, above.data.error?.message]).toEqual([400, 'threshold exceeds Uint<64>']);
        const largest = await fn("'18446744073709551615'");
        expect(JSON.stringify(largest.data)).not.toMatch(/threshold/);
        // Text in a URL is quoted. A bare number there is no text.
        const bare = await fn('5');
        expect([bare.status, bare.data.error?.target]).toEqual([400, 'threshold']);
    });

    test('an instant a caller sends is a timestamp: UNIX seconds and the former name are refused', async () => {
        const body = (over: Record<string, unknown>) => ({
            payloadHash: H('a'), fieldKey: H('b'), value: '1', fieldSalt: H('c'), threshold: '5', predicate: 'lessOrEqual',
            siblings: [H('1'), H('2'), H('3'), H('4')], dirs: [true, false, true, false],
            sessionId: '00000000-0000-4000-8000-000000000001', contractAddress: H('d'), ...over
        });
        const seconds = await cap.axios.post(`${API}/proveFieldPredicate`, body({ validUntil: 1_900_000_000 }), AUTH);
        expect([seconds.status, seconds.data.error?.code, seconds.data.error?.target]).toEqual([400, 'ASSERT_DATA_TYPE', 'validUntil']);
        const past = await cap.axios.post(`${API}/proveFieldPredicate`, body({ validUntil: '2020-01-01T00:00:00Z' }), AUTH);
        expect([past.status, past.data.error?.message]).toEqual([400, 'validUntil must lie at least a minute in the future']);
        const farAhead = await cap.axios.post(`${API}/proveFieldPredicate`, body({ validUntil: new Date(Date.now() + 6 * 365 * 86_400_000).toISOString() }), AUTH);
        expect([farAhead.status, farAhead.data.error?.message]).toEqual([400, 'validUntil may lie at most five years ahead; the vault refuses longer claims']);

        const send = { sessionId: '00000000-0000-4000-8000-000000000001', receiverAddress: `mn_addr_preview1${'q'.repeat(50)}`, amount: '1' };
        const formerName = await cap.axios.post(`${API}/sendToken`, { ...send, ttlIso: new Date(Date.now() + 60_000).toISOString() }, AUTH);
        expect(formerName.status).toBe(400);
        expect(JSON.stringify(formerName.data)).toMatch(/ttlIso/);
        const noTime = await cap.axios.post(`${API}/sendToken`, { ...send, expiresAt: 'soon' }, AUTH);
        expect([noTime.status, noTime.data.error?.code, noTime.data.error?.target]).toEqual([400, 'ASSERT_DATA_TYPE', 'expiresAt']);
    });

    test('the model declares every expiry a caller sends as a timestamp', () => {
        const typed: Record<string, string> = {};
        const collect = (owner: string, params: Record<string, Record<string, unknown>> | undefined) => {
            for (const name of ['validUntil', 'expiresAt', 'ttlIso']) if (params?.[name]) typed[`${owner}.${name}`] = String(params[name].type);
        };
        for (const [name, definition] of Object.entries(cds.model!.definitions as Record<string, any>)) {
            if (definition.kind === 'action' || definition.kind === 'function') collect(name, definition.params);
        }
        expect(Object.keys(typed).length).toBeGreaterThan(10);
        expect(Object.entries(typed).filter(([, type]) => type !== 'cds.Timestamp')).toEqual([]);
        expect(Object.keys(typed).filter(name => name.endsWith('.ttlIso'))).toEqual([]);
    });

    test('every page size of the model declares its range, so none is cut down silently', () => {
        const ranges: Record<string, unknown> = {};
        const collect = (owner: string, params: Record<string, Record<string, unknown>> | undefined) => {
            if (params?.limit) ranges[owner] = params.limit['@assert.range'];
        };
        for (const [name, definition] of Object.entries(cds.model!.definitions as Record<string, any>)) {
            if (definition.kind === 'action' || definition.kind === 'function') collect(name, definition.params);
            for (const [bound, operation] of Object.entries((definition.actions ?? {}) as Record<string, any>)) collect(`${name}.${bound}`, operation.params);
        }
        expect(ranges).toEqual({
            'NightgateService.Transactions.byHash': [1, 5000],
            'NightgateService.listSwapOffers': [1, 200],
            'NightgateIndexerService.getReorgHistory': [1, 100],
            'NightgateAdminService.reconcileNightBalances': [1, 500]
        });
    });

    test('a page size outside its range is refused, not cut down', async () => {
        const refusal = async (url: string) => {
            const r = await cap.axios.get(url, AUTH);
            return [r.status, r.data.error?.code, r.data.error?.target];
        };
        expect(await refusal(`${API}/listSwapOffers(limit=201)`)).toEqual([400, 'ASSERT_RANGE', 'limit']);
        expect(await refusal(`${API}/listSwapOffers(limit=0)`)).toEqual([400, 'ASSERT_RANGE', 'limit']);
        expect(await refusal('/odata/v4/midnight-indexer/getReorgHistory(limit=5000)')).toEqual([400, 'ASSERT_RANGE', 'limit']);
        expect(await refusal('/odata/v4/midnight-indexer/getReorgHistory(limit=0)')).toEqual([400, 'ASSERT_RANGE', 'limit']);
        const inRange = await cap.axios.get('/odata/v4/midnight-indexer/getReorgHistory(limit=100)', AUTH);
        expect(inRange.status).toBe(200);
    });

    test('the hex format of a list is left to the handler', async () => {
        // CAP does not apply @assert.format to the items of a list.
        const r = await cap.axios.post(`${API}/proveFieldPredicate`, {
            payloadHash: H('a'), fieldKey: H('b'), value: '1', fieldSalt: H('c'), threshold: '5', predicate: 'lessOrEqual',
            siblings: [H('1'), H('2'), H('3'), 'short'], dirs: [true, false, true, false],
            sessionId: '00000000-0000-4000-8000-000000000001', contractAddress: H('d')
        }, AUTH);
        expect(r.status).toBe(400);
        expect(r.data.error.message).toMatch(/siblings entries must be 64 hex/);
    });
});
