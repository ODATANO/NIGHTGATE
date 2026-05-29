// Runs `cds watch` with a 12 GB Node heap.
//
// First-time shielded chain scans on preprod allocate well past Node's 4 GB
// default and OOM during contract deploys (proof generation pushes higher).
// We set NODE_OPTIONS BEFORE spawning so it can't be forgotten in another
// terminal. Future tweaks: lower to 8 GB once `serialize`/`restore` is wired.

import { spawn } from 'node:child_process';

const HEAP_MB = process.env.NIGHTGATE_HEAP_MB || '12288';
const existing = process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : '';
process.env.NODE_OPTIONS = `${existing}--max-old-space-size=${HEAP_MB}`;

console.log(`[dev.mjs] NODE_OPTIONS = ${process.env.NODE_OPTIONS}`);
console.log('[dev.mjs] spawning: cds watch');

const child = spawn('cds', ['watch'], {
    stdio: 'inherit',
    shell: true,
    env: process.env
});

child.on('exit', code => process.exit(code ?? 0));
process.on('SIGINT',  () => child.kill('SIGINT'));
process.on('SIGTERM', () => child.kill('SIGTERM'));
