// Runs `cds watch` with a 12 GB Node heap, since first shielded chain scans run out of the 4 GB default.

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
