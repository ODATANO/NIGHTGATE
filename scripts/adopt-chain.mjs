#!/usr/bin/env node
// Moves the database to the chain its node serves, after that chain was started again. Without --apply it only reports.
// Run: node scripts/adopt-chain.mjs [--apply]. Stop the server before --apply. Exit 0 means the database is on the node's chain.
// Env: the server's NIGHTGATE_NODE_URL or NIGHTGATE_CRAWLER_NODE_URL, and NIGHTGATE_DB_URL or NIGHTGATE_DB_PATH.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const say = (message) => console.log(`[adopt-chain] ${message}`);


const APPLY = process.argv.includes('--apply');
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));

const cds = require('@sap/cds');
const { postgresCredentials, postgresKind } = await import(new URL('../docker/cds-config.mjs', import.meta.url).href);

const dbUrl = String(process.env.NIGHTGATE_DB_URL ?? '').trim();
if (dbUrl) {
    cds.env.requires.kinds = { ...(cds.env.requires.kinds ?? {}), postgres: postgresKind() };
    cds.env.requires.db = { kind: 'postgres', credentials: postgresCredentials(dbUrl) };
} else {
    const dbPath = path.resolve(positional[0] || process.env.NIGHTGATE_DB_PATH || path.join(packageRoot, 'db/midnight.db'));
    if (!fs.existsSync(dbPath)) {
        console.error(`[adopt-chain] no database at ${dbPath} (pass the path as an argument, set NIGHTGATE_DB_PATH, or NIGHTGATE_DB_URL for PostgreSQL)`);
        process.exit(2);
    }
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: dbPath } };
}

const fromServer = (file) => require(path.join(packageRoot, file));
const { adoptNodeChain } = fromServer('srv/crawler/reindex.js');
const { MidnightNodeProvider } = fromServer('srv/providers/MidnightNodeProvider.js');
const { getNightgateConfig, resolveNightgateRuntimeConfig } = fromServer('srv/utils/nightgate-config.js');
const { redactUrlCredentials } = fromServer('srv/utils/redact-url.js');
const { configMs } = fromServer('srv/utils/config.js');
const lease = fromServer('srv/utils/instance-lease.js');

const { crawlerNodeUrl } = resolveNightgateRuntimeConfig(getNightgateConfig());
if (!crawlerNodeUrl) {
    console.error('[adopt-chain] no node: set NIGHTGATE_NODE_URL to the node the server indexes from');
    process.exit(2);
}

const model = await cds.load('*');
cds.model = cds.compile.for.nodejs(model);
const db = await cds.connect.to('db');
const node = new MidnightNodeProvider({ nodeUrl: crawlerNodeUrl, maxReconnectAttempts: 1 });
const holder = `adopt-chain:${process.pid}`;
let heldLease = false;
let stopHeartbeat;

try {
    if (APPLY) {
        // The lease proves that no server writes to this database, and keeps one from starting meanwhile.
        const ttlMs = configMs('NIGHTGATE_INSTANCE_LEASE_TTL_MS');
        const attempt = await lease.tryAcquireInstanceLease(db, lease.BACKGROUND_LEASE_ROLE, holder, ttlMs);
        if (!attempt.acquired) {
            throw new Error(`a server holds this database (${attempt.holder}, last sign of life ${Math.round(attempt.heartbeatAgeMs / 1000)} s ago). Stop it first, then wait ${Math.round(ttlMs / 1000)} s.`);
        }
        heldLease = true;
        stopHeartbeat = lease.startInstanceLeaseHeartbeat(db, lease.BACKGROUND_LEASE_ROLE, holder, Math.floor(ttlMs / 3),
            () => console.error('[adopt-chain] ! another process took the database while this ran'), () => undefined);
    }

    say(`node: ${redactUrlCredentials(crawlerNodeUrl)}`);
    await node.connect();
    const report = await adoptNodeChain(db, {
        head: async () => {
            const hash = await node.getFinalizedHead();
            return { hash, height: MidnightNodeProvider.parseBlockNumber((await node.getHeader(hash)).number) };
        },
        hashAt: height => node.getBlockHash(height)
    }, { apply: APPLY });

    say(`index: ${report.indexedHeight === null ? 'empty' : `up to block ${report.indexedHeight}`}; node: finalized up to block ${report.nodeHeight}`);
    if (report.verdict === 'same') {
        say('the node serves the chain this database was indexed from; nothing to do');
    } else if (report.verdict === 'node-behind') {
        say(`the node is behind the index and has shown no other block so far${report.lastCommonHeight === null ? '' : ` (same up to block ${report.lastCommonHeight})`}; nothing to do, run this again when it has caught up`);
    } else {
        say(report.lastCommonHeight === null
            ? 'the node serves another chain: none of the stored blocks is on it'
            : `the node serves another chain: block ${report.lastCommonHeight} is the last one both have`);
        say(`${APPLY ? 'removed' : 'to remove'}: ${report.blocksAbove} stored block(s) with their transactions, and ${report.walletStates} saved wallet state(s)`);
        if (APPLY) {
            say('done. Start the server: it indexes the new chain from there, wallets sync again, and jobs of the old chain end as not included.');
            say('still to do by hand: fund the sponsor wallets and register them for DUST again, deploy contracts again and put their addresses into the sponsor policy');
        } else {
            say('nothing was changed. Stop the server and run this again with --apply.');
            process.exitCode = 1;
        }
    }
} catch (err) {
    console.error(`[adopt-chain] ! ${err?.message ?? err}`);
    process.exitCode = 1;
} finally {
    stopHeartbeat?.();
    await node.disconnect().catch(() => undefined);
    if (heldLease) await lease.releaseInstanceLease(db, lease.BACKGROUND_LEASE_ROLE, holder).catch(() => undefined);
    await cds.disconnect?.();
}
