// The compiled set-root module that @odatano/nightgate-tx ships as `/set-root`.
// It must stay free of CAP and the session-bound modules, because verifiers and browsers load it.

import { createRequire } from 'node:module';
import { sha256 } from '@noble/hashes/sha256';
import { buildMembershipSet as buildFromSource, type SetPureCircuits } from '../../srv/submission/set-root';

const nativeRequire = createRequire(__filename);

const fakePure: SetPureCircuits = {
    setLeafHash: (d) => sha256(Buffer.concat([Buffer.from('setleaf'), Buffer.from(d)])),
    nodeHash: (l, r) => sha256(Buffer.concat([Buffer.from('node'), Buffer.from(l), Buffer.from(r)]))
};

describe('set-root module of the client package', () => {
    it('loads without CAP', () => {
        const before = new Set(Object.keys(nativeRequire.cache));
        const subpath = nativeRequire('../../srv/submission/set-root.js');
        const loaded = Object.keys(nativeRequire.cache).filter(k => !before.has(k));

        const dirty = loaded.filter(k => /@sap[\\/]cds|document-proof|contract-registry|rate-limiter/.test(k));
        expect(dirty).toEqual([]);

        for (const name of ['buildMembershipSet', 'membershipPathFor', 'canonicalSetDigests', 'SET_DEPTH', 'MAX_SET_VALUES']) {
            expect(subpath[name]).toBeDefined();
        }
        expect(subpath.SET_DEPTH).toBe(6);
        expect(subpath.MAX_SET_VALUES).toBe(64);
    });

    it('compiled module and TS source produce identical roots', () => {
        const subpath = nativeRequire('../../srv/submission/set-root.js');
        const values = ['EEA', 'CH', 'NO', 'UK'];
        expect(subpath.buildMembershipSet(values, fakePure).setRoot)
            .toBe(buildFromSource(values, fakePure).setRoot);
    });
});
