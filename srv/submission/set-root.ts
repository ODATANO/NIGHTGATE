/**
 * Canonical depth-6 membership-set tree: blake2b-256 of each exact string,
 * dedupe, sort ascending hex, pad to 64 by repeating the largest digest,
 * leaves via setLeafHash, nodes via nodeHash. Padding must repeat a real
 * member: an empty-leaf constant would be provable as a member of any list.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { blake2b256Hex, fromHex32 } from './hashing';

export const SET_DEPTH = 6;
export const MAX_SET_VALUES = 1 << SET_DEPTH; // 64

export interface SetPureCircuits {
    setLeafHash(valueDigest: Uint8Array): Uint8Array;
    nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array;
}

export interface MembershipPath {
    setRoot: string;        // 64 hex
    setSiblings: string[];  // SET_DEPTH x 64 hex
    setDirs: boolean[];     // SET_DEPTH booleans (true = node is LEFT child)
}

/** More than 64 distinct values throws, never truncates. */
export function canonicalSetDigests(values: string[]): string[] {
    const digests = [...new Set(values.map(v => blake2b256Hex(v)))].sort();
    if (digests.length > MAX_SET_VALUES) {
        throw new Error(`at most ${MAX_SET_VALUES} distinct allowed values (depth-${SET_DEPTH} set tree)`);
    }
    return digests;
}

function buildLevels(digests: string[], pure: SetPureCircuits): Uint8Array[][] {
    if (digests.length === 0) throw new Error('at least one allowed value is required');
    // Every leaf must be a real member's digest (see header).
    const padDigest = digests[digests.length - 1];
    const leaves: Uint8Array[] = [];
    for (let i = 0; i < MAX_SET_VALUES; i++) {
        leaves.push(pure.setLeafHash(fromHex32(digests[i] ?? padDigest)));
    }
    const levels: Uint8Array[][] = [leaves];
    for (let d = 0; d < SET_DEPTH; d++) {
        const prev = levels[d];
        const next: Uint8Array[] = [];
        for (let i = 0; i < prev.length; i += 2) next.push(pure.nodeHash(prev[i], prev[i + 1]));
        levels.push(next);
    }
    return levels;
}

export function buildMembershipSet(values: string[], pure: SetPureCircuits): { setRoot: string; digests: string[] } {
    const digests = canonicalSetDigests(values);
    const levels = buildLevels(digests, pure);
    return { setRoot: bytesToHex(levels[SET_DEPTH][0]), digests };
}

/** Inclusion path of a member digest, or null when it is not in the list. */
export function membershipPathFor(
    values: string[],
    memberDigest: string,
    pure: SetPureCircuits
): MembershipPath | null {
    const digests = canonicalSetDigests(values);
    const idx = digests.indexOf(memberDigest.toLowerCase());
    if (idx === -1) return null;
    const levels = buildLevels(digests, pure);
    const setSiblings: string[] = [];
    const setDirs: boolean[] = [];
    let node = idx;
    for (let d = 0; d < SET_DEPTH; d++) {
        const isLeft = node % 2 === 0;
        setSiblings.push(bytesToHex(levels[d][isLeft ? node + 1 : node - 1]));
        setDirs.push(isLeft);
        node = Math.floor(node / 2);
    }
    return { setRoot: bytesToHex(levels[SET_DEPTH][0]), setSiblings, setDirs };
}
