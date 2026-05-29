// Runs `cds-serve` with a 12 GB Node heap.
//
// Use this for the T15 wallet cold-sync (or any long-running submission flow).
// Unlike `cds watch` (scripts/dev.mjs), cds-serve does NOT restart when the
// SQLite DB grows on disk — important once the wallet sync starts writing
// 100s of MB of shielded-state into midnight.db.
//
// NODE_OPTIONS has to be set before Node starts; .env can't do this because
// it's read by the app after Node is already running.

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
