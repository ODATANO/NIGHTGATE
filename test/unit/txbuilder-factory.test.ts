// `@odatano/nightgate/txbuilder`, token factory: the issuer secret of a seed
// equals the server's rule for a session on that seed; the kit helpers are
// reachable from the builder entry.

import { describe, it, expect } from 'vitest';
import { tokenFactoryIssuerSecret, prepareMint, tokenName } from '../../src/txbuilder/factory.mjs';
import { deriveRoleSeeds } from '../../srv/utils/wallet-hd';
import { deriveTokenFactoryIssuerSecret } from '../../srv/submission/contract-witnesses';

const importTxBuilder = () => import('../../src/txbuilder/index.mjs' as string);

const SEED = 'ab'.repeat(64);

describe('txbuilder: token factory', () => {
    it('derives the issuer secret the server derives for a session on the same seed', async () => {
        const local = await tokenFactoryIssuerSecret({ seedHex: SEED });
        const { zswap } = await deriveRoleSeeds(new Uint8Array(Buffer.from(SEED, 'hex')), 0);
        expect(local).toBe(Buffer.from(deriveTokenFactoryIssuerSecret(zswap)).toString('hex'));
        expect(local).toMatch(/^[0-9a-f]{64}$/);
        expect(await tokenFactoryIssuerSecret({ seedHex: SEED, accountIndex: 1 })).not.toBe(local);
    });
    it('refuses a seed that is not 128 hex', async () => {
        await expect(tokenFactoryIssuerSecret({ seedHex: 'abc' })).rejects.toThrow(/128 hex/);
    });
    it('exposes the kit helpers from the builder entry', async () => {
        const txbuilder: any = await importTxBuilder();
        expect(txbuilder.tokenFactoryIssuerSecret).toBe(tokenFactoryIssuerSecret);
        expect(typeof txbuilder.prepareMint).toBe('function');
        expect(typeof txbuilder.tokenTypeOf).toBe('function');
        const call = prepareMint({ name: 'CREDIT', amount: '1000', recipientCoinPublicKey: '11'.repeat(32), issuerSecret: '22'.repeat(32) });
        expect(call.circuitId).toBe('mint');
        expect(call.args[0]).toEqual(tokenName('CREDIT'));
        expect(call.args[1]).toBe(1000n);
    });
});
