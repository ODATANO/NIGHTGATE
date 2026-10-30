// Runs `cds-serve` with a 12 GB Node heap for long wallet syncs.
// Unlike `cds watch` it does not restart when the SQLite file grows. NODE_OPTIONS must be set before Node starts.

import { spawn } from 'node:child_process';

const HEAP_MB = process.env.NIGHTGATE_HEAP_MB || '12288';
const existing = process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '';
process.env.NODE_OPTIONS = `${existing}--max-old-space-size=${HEAP_MB}`;

console.log(`[serve.mjs] NODE_OPTIONS = ${process.env.NODE_OPTIONS}`);
console.log('[serve.mjs] spawning: cds-serve');

const child = spawn('cds-serve', [], {
    stdio: 'inherit',
    shell: true,
    env: process.env
});

child.on('exit', code => process.exit(code ?? 0));
process.on('SIGINT',  () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
