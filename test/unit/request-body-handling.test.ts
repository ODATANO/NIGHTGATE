/**
 * Request bodies over real HTTP (cds.test boot): a body that is not JSON is answered without quoting it,
 * and the main service takes bodies above the 100 KB express allows by default.
 */
import cds from '@sap/cds';
import { describe, it, expect, vi } from 'vitest';
(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    users: { 'operator-a': { password: 'a-secret', roles: [] } }
};
const cap = cds.test(__dirname + '/../..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { redactInvalidJson } = require('../../srv/utils/http-errors');

const API = '/odata/v4/midnight';
const asA = { authorization: 'Basic ' + Buffer.from('operator-a:a-secret').toString('base64') };
const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

async function send(path: string, body: string) {
    return cap.axios.post(`${API}/${path}`, body, { headers: { ...asA, 'content-type': 'application/json' }, validateStatus: () => true, transformRequest: [(d: string) => d] });
}

describe('a request body that is not JSON', () => {
    it('is answered with a fixed text that quotes nothing of the body, and is logged the same way', async () => {
        const logged: string[] = [];
        const warn = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
        const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
        try {
            // Unquoted, so Node's own message would quote the first words of the phrase.
            const res = await send('deriveWalletInfo', `{"mnemonic": ${PHRASE}}`);
            expect(res.status).toBe(400);
            expect(res.data.error.message).toBe('The request body is not valid JSON');
            expect(JSON.stringify(res.data)).not.toMatch(/abandon|ability/);
            expect(logged.join('\n')).not.toMatch(/abandon|ability/);
        } finally {
            warn.mockRestore(); error.mockRestore();
        }
    });
});

describe('the size of a request body on the main service', () => {
    it('takes 300 KB, which the default limit of 100 KB refused', async () => {
        const res = await send('prepareMembershipSet', JSON.stringify({ values: ['a'], note: 'x'.repeat(300_000) }));
        // Refused for its content, not for its size.
        expect(res.status).not.toBe(413);
    });

    it('refuses a body above 2 MB', async () => {
        const res = await send('prepareMembershipSet', JSON.stringify({ values: ['a'], note: 'x'.repeat(2_200_000) }));
        expect(res.status).toBe(413);
    });
});

describe('redactInvalidJson', () => {
    it('replaces the message and the stack of a body that is not JSON and passes the error on', () => {
        const err = Object.assign(new Error(`Unexpected token 'a', ..."nemonic": abandon ab"... is not valid JSON`), { name: 'Invalid JSON body', status: 400 });
        const next = vi.fn();
        redactInvalidJson(err, {}, {}, next);
        expect(next).toHaveBeenCalledWith(err);
        expect(err.message).toBe('The request body is not valid JSON');
        expect(String(err.stack)).not.toMatch(/abandon/);
        expect(err.status).toBe(400);
    });

    it('leaves every other error as it is', () => {
        const err = new Error('sessionId is required');
        const stack = err.stack;
        const next = vi.fn();
        redactInvalidJson(err, {}, {}, next);
        expect(err.message).toBe('sessionId is required');
        expect(err.stack).toBe(stack);
        expect(next).toHaveBeenCalledWith(err);
    });
});

describe('the caller address without the proxy setting', () => {
    it('is the address of the connection: express trusts no proxy', () => {
        expect((cds as any).app.get('trust proxy')).toBe(false);
    });
});
