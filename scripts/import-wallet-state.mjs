#!/usr/bin/env node
// Loads wallet states written by `scripts/presync-wallets.mjs` into this
// server's WalletSyncStates, so the sponsor wallets restore at the next start
// instead of syncing. Stop the server first: a running wallet overwrites the
// row at its next save.
//
//   node scripts/import-wallet-state.mjs [--dry-run] <export.json>...
//
// Needs the server's environment: the database (NIGHTGATE_DB_URL or the SQLite
// file), the encryption key ring (ENCRYPTION_KEY / ENCRYPTION_KEYS) and
// NIGHTGATE_FEE_SPONSOR_SESSION, because each file is matched to a platform
// sponsor session by its `sessionId`. The file is refused when its seed
// fingerprint, network or SDK version does not match what the server would
// restore. Exit 0 = every file imported, 1 = at least one refused.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The server's package (its node_modules and compiled srv/) is the current directory, or the directory this script sits in.
const packageRoot = fs.existsSync(path.join(process.cwd(), 'srv/submission/wallet-sync-state-store.js')) ? process.cwd() : scriptRoot;
const hostRequire = createRequire(path.join(packageRoot, 'package.json'));

const DRY = process.argv.includes('--dry-run');
const files = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (files.length === 0) {
    console.error('usage: node scripts/import-wallet-state.mjs [--dry-run] <export.json>...');
    process.exit(2);
}

const cds = hostRequire('@sap/cds');
const { postgresCredentials, postgresKind } = await import(pathToFileURL(path.join(packageRoot, 'docker/cds-config.mjs')).href);
const { resolveFeeSponsor, getConfiguredFeeSponsorSessions } = hostRequire(path.join(packageRoot, 'srv/submission/fee-sponsor.js'));
const { saveSyncState, getWalletSdkVersion } = hostRequire(path.join(packageRoot, 'srv/submission/wallet-sync-state-store.js'));
const { seedFingerprintOf } = hostRequire(path.join(packageRoot, 'srv/submission/wallet-facade-builder.js'));

const dbUrl = String(process.env.NIGHTGATE_DB_URL ?? '').trim();
if (dbUrl) {
    hostRequire('@cap-js/postgres/package.json');
    cds.env.requires.kinds = { ...(cds.env.requires.kinds ?? {}), postgres: postgresKind() };
    cds.env.requires.db = { kind: 'postgres', credentials: postgresCredentials(dbUrl) };
} else {
    const dbPath = process.env.NIGHTGATE_DB_PATH ?? path.join(packageRoot, 'db/midnight.db');
    cds.env.requires.db = { kind: 'sqlite', credentials: { url: dbPath } };
}
cds.root = packageRoot;
cds.model = cds.compile.for.nodejs(await cds.load('*'));
const db = await cds.connect.to('db');
const { WalletSyncStates } = cds.entities('midnight');

const sponsors = getConfiguredFeeSponsorSessions();
const expectedSdk = getWalletSdkVersion();
const log = (m) => console.log(`[import] ${m}`);
log(`server SDK ${expectedSdk}, ${sponsors.length} platform sponsor(s)${DRY ? ', dry run' : ''}`);

let refused = 0;
try {
    for (const file of files) {
        const name = path.basename(file);
        let exp;
        try { exp = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { log(`! ${name}: unreadable (${err?.message ?? err})`); refused++; continue; }
        const reasons = [];
        if (exp.version !== 1) reasons.push(`file version ${exp.version}`);
        if (!exp.sessionId) reasons.push('no sessionId in the file');
        else if (!sponsors.includes(exp.sessionId)) reasons.push(`sessionId ${exp.sessionId.slice(0, 8)} is not a platform sponsor here`);
        if (exp.sdkVersion !== expectedSdk) reasons.push(`SDK ${exp.sdkVersion} != server ${expectedSdk} (the server would refuse the restore)`);
        if (!exp.states || !exp.states.shielded || !exp.states.unshielded || !exp.states.dust) reasons.push('states incomplete');
        if (reasons.length) { log(`! ${name}: refused: ${reasons.join('; ')}`); refused++; continue; }

        let sponsor;
        try {
            sponsor = await resolveFeeSponsor({ db, sponsorSessionId: exp.sessionId });
        } catch (err) { log(`! ${name}: sponsor ${exp.sessionId.slice(0, 8)}: ${err?.message ?? err}`); refused++; continue; }
        if (seedFingerprintOf(sponsor.seedHex) !== exp.seedFingerprint) { log(`! ${name}: seed fingerprint differs from the sponsor's seed`); refused++; continue; }
        if ((sponsor.accountIndex ?? 0) !== (exp.accountIndex ?? 0)) { log(`! ${name}: accountIndex ${exp.accountIndex ?? 0} != the session's ${sponsor.accountIndex ?? 0}`); refused++; continue; }
        const row = await db.run(SELECT.one.from(WalletSyncStates).columns('updatedAt', 'networkId', 'sdkVersion').where({ accountId: sponsor.accountId }));
        const have = row ? `current row saved ${row.updatedAt} (${row.sdkVersion}, ${row.networkId})` : 'no row yet';
        const sizes = `sh=${exp.states.shielded.length} un=${exp.states.unshielded.length} du=${exp.states.dust.length}`;
        log(`${name}: sponsor ${exp.sessionId.slice(0, 8)} account ${sponsor.accountId.slice(0, 16)}: file saved ${exp.savedAt}, dust appliedIndex=${exp.reached?.dustAppliedIndex ?? '?'} of ${exp.reached?.streamTip ?? '?'}, ${sizes}; ${have}`);
        if (DRY) continue;
        await saveSyncState({
            accountId: sponsor.accountId,
            passphrase: sponsor.syncStatePassphrase,
            sdkVersion: exp.sdkVersion,
            states: exp.states,
            networkId: exp.networkId,
            seedFingerprint: exp.seedFingerprint
        });
        log(`${name}: written`);
    }
} finally {
    await cds.disconnect?.();
}
process.exit(refused ? 1 : 0);
