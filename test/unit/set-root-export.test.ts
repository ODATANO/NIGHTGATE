/**
 * Guards the public `@odatano/nightgate/set-root` subpath (FR
 * export-set-root-surface): it must resolve via the package exports map
 * (Node self-reference onto the in-place compiled .js) and its module graph
 * must stay dependency-clean, i.e. requiring it never drags in CAP or the
 * session-bound submission modules. Consumers use this subpath outside any
 * server context (anonymous verifiers, browser bundles, unit tests).
 *
 * Needs the in-place compiled .js twins under srv/ (npm test builds first).
 */

import { createRequire } from 'node:module';
import { sha256 } from '@noble/hashes/sha256';
import { buildMembershipSet as buildFromSource, type SetPureCircuits } from '../../srv/submission/set-root';

const nativeRequire = createRequire(__filename);

const fakePure: SetPureCircuits = {
    setLeafHash: (d) => sha256(Buffer.concat([Buffer.from('setleaf'), Buffer.from(d)])),
    nodeHash: (l, r) => sha256(Buffer.concat([Buffer.from('node'), Buffer.from(l), Buffer.from(r)]))
};

describe('@odatano/nightgate/set-root subpath', () => {
    it('resolves through the exports map and stays CAP-free', () => {
        const before = new Set(Object.keys(nativeRequire.cache));
        const subpath = nativeRequire('@odatano/nightgate/set-root');
        const loaded = Object.keys(nativeRequire.cache).filter(k => !before.has(k));

        // The whole point of the subpath: no CAP, no session/submission graph.
        const dirty = loaded.filter(k => /@sap[\\/]cds|document-proof|contract-registry|rate-limiter/.test(k));
        expect(dirty).toEqual([]);

        for (const name of ['buildMembershipSet', 'membershipPathFor', 'canonicalSetDigests', 'SET_DEPTH', 'MAX_SET_VALUES']) {
            expect(subpath[name]).toBeDefined();
        }
        expect(subpath.SET_DEPTH).toBe(6);
        expect(subpath.MAX_SET_VALUES).toBe(64);
    });

    it('compiled subpath and TS source produce identical roots', () => {
        const subpath = nativeRequire('@odatano/nightgate/set-root');
        const values = ['EEA', 'CH', 'NO', 'UK'];
        expect(subpath.buildMembershipSet(values, fakePure).setRoot)
            .toBe(buildFromSource(values, fakePure).setRoot);
    });
});
