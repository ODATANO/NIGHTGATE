/**
 * The two vault lineages must stay the same contract at two widths. The
 * parity check strips comments and width-derived constructs; anything else
 * that differs is drift.
 */
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareVaultSources } from '../../scripts/check-vault-parity.mjs';

const root = join(__dirname, '..', '..');
// Line endings follow the checkout (a Windows clone may carry CRLF until the
// eol attribute applies); the mutations below match LF text.
const readLf = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const src16 = readLf(join(root, 'contracts/attestation-vault/src/attestation-vault.compact'));
const src32 = readLf(join(root, 'contracts/attestation-vault-32/src/attestation-vault-32.compact'));

describe('vault lineage parity', () => {
    test('the shipped sources are identical modulo width', () => {
        const r = compareVaultSources(src16, src32);
        expect(r.problems).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.runs16).toBe(r.runs32);
    });

    test('comments and line endings are not drift', () => {
        const crlf = src16.replace(/\n/g, '\r\n') + '\r\n// trailing note\r\n';
        expect(compareVaultSources(crlf, src32 + '\n// another note\n').ok).toBe(true);
    });

    test('a changed assert message is drift', () => {
        const mutated = src32.replace('"not committer"', '"not the committer"');
        expect(mutated).not.toBe(src32);
        const r = compareVaultSources(src16, mutated);
        expect(r.ok).toBe(false);
        expect(r.problems[0]).toMatch(/drift at 16er line \d+ vs 32er line \d+/);
    });

    test('an added statement on one side is drift', () => {
        const mutated = src16.replace('attest_commits.remove(disclose(key));', 'attest_commits.remove(disclose(key));\n  attest_seq_next = 0;');
        expect(mutated).not.toBe(src16);
        expect(compareVaultSources(mutated, src32).ok).toBe(false);
    });

    test('a dropped guard is drift', () => {
        const line = 'assert(!guarded_attestations.member(disclose(payload_hash)), "attestation is guarded");';
        expect(src32).toContain(line);
        expect(compareVaultSources(src16, src32.replace(line, '')).ok).toBe(false);
    });

    test('a width token left at 16 in the 32er is drift', () => {
        const mutated = src32.replace('k >= 1 && k <= 32', 'k >= 1 && k <= 16');
        expect(mutated).not.toBe(src32);
        expect(compareVaultSources(src16, mutated).ok).toBe(false);
    });

    test('fewer unrolled slots on the 32er is drift', () => {
        const mutated = src32.replace('    slotLeaf(ds[31], os[31], slotSalt(seed, 31))\n', '');
        expect(mutated).not.toBe(src32);
        const r = compareVaultSources(src16, mutated);
        expect(r.ok).toBe(false);
    });
});
