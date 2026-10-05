// Fails on code patterns that have a typed or shared replacement (see CLAUDE.md, Conventions).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const files = execSync('git ls-files -co --exclude-standard -- src srv db', { encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(ts|mts|mjs|cds)$/.test(f) && !/\.d\.m?ts$/.test(f));

const rules = [
    { re: /—/, why: 'em dash; use a comma, colon or parentheses' },
    { re: /^\s*(export\s+)?(interface|type)\s+\w+Row\b/, why: 'hand-written row type; use the cds-typer class from #cds-models' },
    { re: /\/\/\s*64 hex\s*($|;)/, why: "'// 64 hex' comment; use the Hex64 type" },
    { re: /\.(set|entries)\(.*\bas any\b/, why: "'as any' in a DB write; fix the model or the generated types" },
    { re: /\breq\.data as\b/, why: "'req.data as'; register the handler with the generated action: srv.on(action, req => ...)" }
];

const hits = [];
for (const file of files) {
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    text.split(/\r?\n/).forEach((line, i) => {
        for (const rule of rules) if (rule.re.test(line)) hits.push(`${file}:${i + 1}  ${rule.why}`);
    });
}
if (hits.length) {
    console.error(`Convention violations:\n  ${hits.join('\n  ')}`);
    process.exit(1);
}
