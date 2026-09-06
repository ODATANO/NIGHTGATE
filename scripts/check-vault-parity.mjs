#!/usr/bin/env node
// Structural parity of the two attestation-vault lineages.
//
// contracts/attestation-vault (16 slots, depth 4) and
// contracts/attestation-vault-32 (32 slots, depth 5) must be the SAME
// contract at two widths: every circuit, assertion and ledger declaration
// identical, only the width-derived constructs differing (vector widths,
// fold arity, inclusion-path depth, unrolled per-slot lines). Comments are
// free text and are not compared.
//
// Method: strip comments, normalise whitespace, rewrite the width tokens
// (Vector<16|32,>, Vector<4|5,> for the path depth, fold16|fold32, k <= 16|32)
// to placeholders, replace slot/level indices with `#`, then collapse runs of
// identical lines. The collapsed line sequences must be identical, and a
// run may only be as long or longer on the 32er (it unrolls more slots).
// Any other difference (a changed assert message, an added statement, a
// dropped guard) is reported with the original line numbers of both files.
//
// Run: node scripts/check-vault-parity.mjs   (exit 1 on drift)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WIDTH_TOKENS = {
    16: [[/Vector<16,/g, 'Vector<W,'], [/Vector<4,/g, 'Vector<D,'], [/\bfold16\b/g, 'foldW'], [/k <= 16\b/g, 'k <= W']],
    32: [[/Vector<32,/g, 'Vector<W,'], [/Vector<5,/g, 'Vector<D,'], [/\bfold32\b/g, 'foldW'], [/k <= 32\b/g, 'k <= W']]
};

/**
 * Normalise one source into [{ text, count, firstLine, lastLine }] runs.
 * @param {string} source
 * @param {16 | 32} width
 */
export function normalizeVaultSource(source, width) {
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    lines.forEach((raw, idx) => {
        let line = raw.replace(/\/\/.*$/, '').trim().replace(/\s+/g, ' ');
        if (line === '') return;
        for (const [re, to] of WIDTH_TOKENS[width]) line = line.replace(re, to);
        // Slot and level indices: ds[15], sibs[3], l31, a7, n4, slotSalt(seed, 9).
        line = line
            .replace(/\[(\d+)\]/g, '[#]')
            .replace(/\b([a-z]+)\d+\b/g, '$1#')
            .replace(/slotSalt\(seed, \d+\)/g, 'slotSalt(seed, #)');
        // Fold layers: the letter names a level (a, b, c); the 32er has one more.
        line = line.replace(/\bconst [a-z]# = nodeHash\([a-z]#, [a-z]#\);/, 'const L# = nodeHash(L#, L#);')
            .replace(/nodeHash\(nodeHash\([a-z]#, [a-z]#\), nodeHash\([a-z]#, [a-z]#\)\)/, 'nodeHash(nodeHash(L#, L#), nodeHash(L#, L#))');
        const prev = out[out.length - 1];
        if (prev && prev.text === line) {
            prev.count += 1;
            prev.lastLine = idx + 1;
        } else {
            out.push({ text: line, count: 1, firstLine: idx + 1, lastLine: idx + 1 });
        }
    });
    return out;
}

/**
 * Compare the two sources. Returns { ok, problems: string[] }.
 * @param {string} src16
 * @param {string} src32
 */
export function compareVaultSources(src16, src32) {
    const a = normalizeVaultSource(src16, 16);
    const b = normalizeVaultSource(src32, 32);
    const problems = [];
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i].text !== b[i].text) {
            problems.push(`drift at 16er line ${a[i].firstLine} vs 32er line ${b[i].firstLine}:\n    16: ${a[i].text}\n    32: ${b[i].text}`);
            break;
        }
        if (b[i].count < a[i].count) {
            problems.push(`32er unrolls FEWER lines than the 16er at 16er line ${a[i].firstLine} (${a[i].count}) vs 32er line ${b[i].firstLine} (${b[i].count}): ${a[i].text}`);
            break;
        }
    }
    if (problems.length === 0 && a.length !== b.length) {
        const extra = a.length > b.length ? a[n] : b[n];
        const which = a.length > b.length ? '16er' : '32er';
        problems.push(`${which} has extra code from its line ${extra.firstLine}: ${extra.text}`);
    }
    return { ok: problems.length === 0, problems, runs16: a.length, runs32: b.length };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const src16 = readFileSync(join(root, 'contracts/attestation-vault/src/attestation-vault.compact'), 'utf8');
    const src32 = readFileSync(join(root, 'contracts/attestation-vault-32/src/attestation-vault-32.compact'), 'utf8');
    const result = compareVaultSources(src16, src32);
    if (!result.ok) {
        console.error('check-vault-parity: the two vault lineages drifted apart:');
        for (const p of result.problems) console.error(`  ${p}`);
        process.exit(1);
    }
    console.log(`check-vault-parity: ok (${result.runs16} collapsed lines, identical modulo width)`);
}
