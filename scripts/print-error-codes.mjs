#!/usr/bin/env node
// Prints the markdown rows of docs/reference.md's error-code table from the
// registry (build output: run `npm run build` first). `npm run errors:table`
// refreshes the block between the error-codes markers and the retry list of the client.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { errorCodeMarkdownRows, retryableErrorCodes } = require('../srv/utils/errors.js');
const rows = errorCodeMarkdownRows().join('\n');

if (process.argv.includes('--write')) {
    const doc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/reference.md');
    const text = readFileSync(doc, 'utf8');
    const start = text.indexOf('<!-- error-codes:start -->');
    const end = text.indexOf('<!-- error-codes:end -->');
    if (start < 0 || end < 0) throw new Error('docs/reference.md: error-codes markers not found');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const header = ['| Code | HTTP | Job | Retryable | Meaning |', '|---|---|---|---|---|'].join(eol);
    const next = text.slice(0, start) + '<!-- error-codes:start -->' + eol + header + eol + rows.replace(/\n/g, eol) + eol + text.slice(end);
    writeFileSync(doc, next);
    console.log(`docs/reference.md: ${errorCodeMarkdownRows().length} error codes written`);

    const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/sdk/client.mjs');
    const source = readFileSync(client, 'utf8');
    const from = source.indexOf('// retryable-codes:start');
    const to = source.indexOf('// retryable-codes:end');
    if (from < 0 || to < 0) throw new Error('src/sdk/client.mjs: retryable-codes markers not found');
    const nl = source.includes('\r\n') ? '\r\n' : '\n';
    const codes = retryableErrorCodes();
    const lines = [];
    for (let i = 0; i < codes.length; i += 4) lines.push('    ' + codes.slice(i, i + 4).map(c => `'${c}'`).join(', ') + (i + 4 < codes.length ? ',' : ''));
    writeFileSync(client, source.slice(0, from) + '// retryable-codes:start' + nl + lines.join(nl) + nl + '    ' + source.slice(to));
    console.log(`src/sdk/client.mjs: ${codes.length} retryable codes written`);
} else {
    process.stdout.write(rows + '\n');
}
