/**
 * Membership-set tree for proveFieldMembership.
 *
 * A public allow-list of string values becomes a fixed depth-6 Merkle tree
 * (up to 64 slots) whose root is the public statement a membership proof
 * binds to. The rule is CANONICAL so any verifier can recompute the root
 * from the published list alone:
 *
 *   1. digest each allowed value: blake2b-256 of the exact UTF-8 string
 *      (same digesting as bytes-kind proof fields in document-proof.ts)
 *   2. dedupe digests
 *   3. sort ascending bytewise (hex-lexicographic on lowercase hex)
 *   4. pad to 64 slots by REPEATING the last (sorted-largest) member digest
 *   5. leaf = setLeafHash(digest) via the contract artifact's pure circuit
 *      (domain-separated from content-tree leaves), inner nodes via nodeHash
 *
 * Padding rule 4 is security-relevant: every leaf of the tree MUST be a real
 * member's digest, so the in-circuit set fold proves exactly "digest is one
 * of the member digests". A designated empty-leaf constant would be provable
 * as a member of any non-full list: with a known preimage (a label string)
 * by anchoring that string as the field value, and with ANY constant by
 * anchoring the constant digest directly in a crafted content root (bytes
 * leaves need no preimage). Repeating a member closes both.
 *
 * More than 64 DISTINCT values is an error, not a truncation.
 */

import { bytesToHex } from '@noble/hashes/utils';
import { blake2b256Hex, fromHex32 } from './hashing';

export const SET_DEPTH = 6;
export const MAX_SET_VALUES = 1 << SET_DEPTH; // 64

/** The pure-circuit subset the set builder needs. */
export interface SetPureCircuits {
    setLeafHash(valueDigest: Uint8Array): Uint8Array;
    nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array;
}

export interface MembershipPath {
    setRoot: string;        // 64 hex
    setSiblings: string[];  // SET_DEPTH x 64 hex
    setDirs: boolean[];     // SET_DEPTH booleans (true = node is LEFT child)
}

/**
 * Canonical digest list for an allow-list: digest, dedupe, sort ascending.
 * Throws when the distinct count exceeds the tree capacity.
 */
export function canonicalSetDigests(values: string[]): string[] {
    const digests = [...new Set(values.map(v => blake2b256Hex(v)))].sort();
    if (digests.length > MAX_SET_VALUES) {
        throw new Error(`at most ${MAX_SET_VALUES} distinct allowed values (depth-${SET_DEPTH} set tree)`);
    }
    return digests;
}

function buildLevels(digests: string[], pure: SetPureCircuits): Uint8Array[][] {
    if (digests.length === 0) throw new Error('at least one allowed value is required');
    // Pad slots repeat the LAST member digest (see the canonical-rule note in
    // the header: every leaf must be a real member's digest).
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

/** Canonical set root over an allow-list of raw string values. */
export function buildMembershipSet(values: string[], pure: SetPureCircuits): { setRoot: string; digests: string[] } {
    const digests = canonicalSetDigests(values);
    const levels = buildLevels(digests, pure);
    return { setRoot: bytesToHex(levels[SET_DEPTH][0]), digests };
}

/**
 * Inclusion path of one member digest in the canonical set tree, or null
 * when the digest is not in the list. `memberDigest` is 64 hex (lowercased
 * for the lookup).
 */
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
