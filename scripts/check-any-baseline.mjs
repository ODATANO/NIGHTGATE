// Fails when a file in eslint.any-baseline.json carries more `any` than recorded.
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { ESLint } from 'eslint';

const file = new URL('../eslint.any-baseline.json', import.meta.url);
const baseline = JSON.parse(readFileSync(file, 'utf8'));
const results = await new ESLint().lintFiles(Object.keys(baseline));
const grown = [];
const next = {};
for (const r of results) {
    const rel = relative(process.cwd(), r.filePath).split(sep).join('/');
    const n = r.messages.filter(m => m.ruleId === '@typescript-eslint/no-explicit-any').length;
    if (n > baseline[rel]) grown.push(`${rel}: ${baseline[rel]} -> ${n}`);
    if (n > 0) next[rel] = Math.min(n, baseline[rel]);
}
if (grown.length) {
    console.error(`any count grew:\n  ${grown.join('\n  ')}`);
    process.exit(1);
}
if (JSON.stringify(next) !== JSON.stringify(baseline)) {
    writeFileSync(file, JSON.stringify(next, null, 4) + '\n');
    console.log('eslint.any-baseline.json lowered');
}
