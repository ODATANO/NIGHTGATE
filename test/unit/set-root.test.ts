/**
 * Unit tests for srv/submission/set-root.ts: the canonical membership-set
 * rule (digest, dedupe, sort ascending, pad to 64) and path extraction.
 * Pure circuits are faked deterministically (tagged sha256), mirroring
 * document-proof.test.ts; real-artifact parity is the live e2e's job.
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
    canonicalSetDigests,
    buildMembershipSet,
    membershipPathFor,
    SET_DEPTH,
    MAX_SET_VALUES,
    type SetPureCircuits
} from '../../srv/submission/set-root';
import { blake2b256Hex } from '../../srv/submission/document-proof';

const fakePure: SetPureCircuits = {
    setLeafHash: (d) => sha256(Buffer.concat([Buffer.from('setleaf'), Buffer.from(d)])),
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

describe('canonicalSetDigests', () => {
    it('digests, dedupes and sorts ascending', () => {
        const digests = canonicalSetDigests(['b', 'a', 'b', 'c']);
        expect(digests).toHaveLength(3);
        expect(digests).toEqual([...digests].sort());
        expect(digests).toContain(blake2b256Hex('a'));
    });

    it('caps at 64 DISTINCT values (duplicates do not count)', () => {
        const sixtyFour = Array.from({ length: MAX_SET_VALUES }, (_, i) => `v${i}`);
        expect(canonicalSetDigests([...sixtyFour, 'v0', 'v1'])).toHaveLength(64);
        expect(() => canonicalSetDigests([...sixtyFour, 'one-too-many'])).toThrow(/at most 64/);
    });
});

describe('buildMembershipSet + membershipPathFor', () => {
    const VALUES = ['EEA', 'CH', 'NO', 'UK'];

    it('produces the same root for permuted and duplicated lists', () => {
        const a = buildMembershipSet(VALUES, fakePure);
        const b = buildMembershipSet(['UK', 'NO', 'EEA', 'CH', 'CH'], fakePure);
        expect(b.setRoot).toBe(a.setRoot);
    });

    it('different lists produce different roots (padding is not a collision)', () => {
        const a = buildMembershipSet(VALUES, fakePure);
        const b = buildMembershipSet([...VALUES, 'US'], fakePure);
        expect(b.setRoot).not.toBe(a.setRoot);
    });

    it('every member path refolds to the root; non-members return null', () => {
        const { setRoot } = buildMembershipSet(VALUES, fakePure);
        for (const v of VALUES) {
            const path = membershipPathFor(VALUES, blake2b256Hex(v), fakePure);
            expect(path).not.toBeNull();
            expect(path!.setRoot).toBe(setRoot);
            expect(path!.setSiblings).toHaveLength(SET_DEPTH);
            expect(path!.setDirs).toHaveLength(SET_DEPTH);
            const leaf = Buffer.from(fakePure.setLeafHash(Buffer.from(blake2b256Hex(v), 'hex'))).toString('hex');
            expect(refold(leaf, path!.setSiblings, path!.setDirs)).toBe(setRoot);
        }
        expect(membershipPathFor(VALUES, blake2b256Hex('DE'), fakePure)).toBeNull();
    });

    it('accepts uppercase member digests (lowercased for lookup)', () => {
        const path = membershipPathFor(VALUES, blake2b256Hex('CH').toUpperCase(), fakePure);
        expect(path).not.toBeNull();
    });

    it('a full 64-value set still folds (no padding slots left)', () => {
        const values = Array.from({ length: MAX_SET_VALUES }, (_, i) => `v${i}`);
        const { setRoot } = buildMembershipSet(values, fakePure);
        const path = membershipPathFor(values, blake2b256Hex('v33'), fakePure);
        expect(path!.setRoot).toBe(setRoot);
    });

    it('ADVERSARIAL: padding slots hold a real member digest, never a provable constant', () => {
        // Pre-fix, padding was setLeafHash(blake2b256(<label>)): the label has
        // a KNOWN preimage, so anchoring the label string as a field value
        // made it provable as a member of ANY non-full list. Padding must
        // repeat a real member digest instead.
        const oldPadLabel = 'nightgate/set-root/empty/v1';
        const digests = canonicalSetDigests(VALUES);
        const lastMemberLeaf = Buffer.from(fakePure.setLeafHash(Buffer.from(digests[digests.length - 1], 'hex'))).toString('hex');
        const attackLeaf = Buffer.from(fakePure.setLeafHash(Buffer.from(blake2b256Hex(oldPadLabel), 'hex'))).toString('hex');

        // Rebuild the canonical tree levels locally and extract a PADDING
        // slot's inclusion path (slot index >= member count).
        const padDigest = digests[digests.length - 1];
        const leaves: Uint8Array[] = [];
        for (let i = 0; i < MAX_SET_VALUES; i++) {
            leaves.push(fakePure.setLeafHash(Buffer.from(digests[i] ?? padDigest, 'hex')));
        }
        const levels: Uint8Array[][] = [leaves];
        for (let d = 0; d < SET_DEPTH; d++) {
            const prev = levels[d];
            const next: Uint8Array[] = [];
            for (let i = 0; i < prev.length; i += 2) next.push(fakePure.nodeHash(prev[i], prev[i + 1]));
            levels.push(next);
        }
        const setRoot = Buffer.from(levels[SET_DEPTH][0]).toString('hex');
        expect(setRoot).toBe(buildMembershipSet(VALUES, fakePure).setRoot);
        const padSlot = digests.length; // first padding slot
        const siblings: string[] = [];
        const dirs: boolean[] = [];
        let node = padSlot;
        for (let d = 0; d < SET_DEPTH; d++) {
            const isLeft = node % 2 === 0;
            siblings.push(Buffer.from(levels[d][isLeft ? node + 1 : node - 1]).toString('hex'));
            dirs.push(isLeft);
            node = Math.floor(node / 2);
        }

        // The padding slot folds to the root ONLY with the repeated member
        // digest; the old label digest (or any non-member) does not fold.
        expect(refold(lastMemberLeaf, siblings, dirs)).toBe(setRoot);
        expect(refold(attackLeaf, siblings, dirs)).not.toBe(setRoot);
        // And the attack value is not treated as a member anywhere.
        expect(VALUES).not.toContain(oldPadLabel);
        expect(membershipPathFor(VALUES, blake2b256Hex(oldPadLabel), fakePure)).toBeNull();
        // No leaf of the tree equals the attack leaf at all.
        const leafHexes = leaves.map(l => Buffer.from(l).toString('hex'));
        expect(leafHexes).not.toContain(attackLeaf);
    });
});
