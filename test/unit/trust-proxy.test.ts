/**
 * NIGHTGATE_TRUST_PROXY over a real boot (cds.test): the server entry hands the number of proxies to express,
 * which then reads the caller address from X-Forwarded-For.
 */
import cds from '@sap/cds';
import { describe, it, expect } from 'vitest';
process.env.NIGHTGATE_TRUST_PROXY = '2';
(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: { 'operator-a': { password: 'a-secret', roles: [] } }
};
const cap = cds.test(__dirname + '/../..');

describe('the caller address behind reverse proxies', () => {
    it('tells express the number of proxies to trust', async () => {
        // A request makes sure the server is up before its app is read.
        await cap.axios.get('/odata/v4/midnight-indexer/getLiveness()', { validateStatus: () => true });
        expect((cds as any).app.get('trust proxy')).toBe(2);
    });
});
