#!/usr/bin/env node
// Prints the markdown rows of docs/reference.md's error-code table from the
// registry (build output: run `npm run build` first). `npm run errors:table`
// refreshes the block between the error-codes markers.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { errorCodeMarkdownRows } = require('../srv/utils/errors.js');
const rows = errorCodeMarkdownRows().join('\n');

if (process.argv.includes('--write')) {
    const doc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/reference.md');
    const text = readFileSync(doc, 'utf8');
    const start = text.indexOf('<!-- error-codes:start -->');
    const end = text.indexOf('<!-- error-codes:end -->');
    if (start < 0 || end < 0) throw new Error('docs/reference.md: error-codes markers not found');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const header = ['| Code | HTTP | Retryable | Meaning |', '|---|---|---|---|'].join(eol);
    const next = text.slice(0, start) + '<!-- error-codes:start -->' + eol + header + eol + rows.replace(/\n/g, eol) + eol + text.slice(end);
    writeFileSync(doc, next);
    console.log(`docs/reference.md: ${errorCodeMarkdownRows().length} error codes written`);
} else {
    process.stdout.write(rows + '\n');
}
