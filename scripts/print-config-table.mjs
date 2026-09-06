#!/usr/bin/env node
// Prints the markdown rows of docs/reference.md's environment table from the
// config table (build output: run `npm run build` first). `npm run config:table`
// refreshes the block between the config-table markers.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { configTableMarkdownRows } = require('../srv/utils/config-table.js');
const rows = configTableMarkdownRows().join('\n');

if (process.argv.includes('--write')) {
    const doc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs/reference.md');
    const text = readFileSync(doc, 'utf8');
    const start = text.indexOf('<!-- config-table:start -->');
    const end = text.indexOf('<!-- config-table:end -->');
    if (start < 0 || end < 0) throw new Error('docs/reference.md: config-table markers not found');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const header = ['| Variable | Kind | Default | Purpose |', '|---|---|---|---|'].join(eol);
    const next = text.slice(0, start) + '<!-- config-table:start -->' + eol + header + eol + rows.replace(/\n/g, eol) + eol + text.slice(end);
    writeFileSync(doc, next);
    console.log(`docs/reference.md: ${configTableMarkdownRows().length} rows written`);
} else {
    process.stdout.write(rows + '\n');
}
