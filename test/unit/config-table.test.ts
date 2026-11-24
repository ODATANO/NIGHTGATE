/**
 * The typed config table (`srv/utils/config-table.ts` + `config.ts`): one
 * parser for every knob, the CAP mapping, the worker snapshot, and the docs
 * pinned to the table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    CONFIG_TABLE, camelConfigKey, capConfigKey, capConfigValue, formerCapKeys, formerEnvKeys, parseConfigValue, configSpec, configTableMarkdownRows, resolveConfigTable
} from '../../srv/utils/config-table';
import {
    __resetConfigForTests, configMs, configNumber, configInt, configBool, configFlag, configString, configEnum, configList,
    configIsSet, pinResolvedConfig, resolvedConfigSnapshot, setConfigOverrideSource, setConfigWarnSink, configNumberFrom
} from '../../srv/utils/config';

const KEYS = ['NIGHTGATE_WORKER_RPC_TIMEOUT_MS', 'NIGHTGATE_SAVE_INTERVAL_MS', 'NIGHTGATE_CRAWLER_ENABLED', 'NIGHTGATE_PROVING_MODE',
    'NIGHTGATE_FEE_SPONSOR_SESSIONS', 'NIGHTGATE_PREWARM_STALL_MS', 'NIGHTGATE_SIGNING_RATE_LIMIT', 'NIGHTGATE_WORKER_YOUNG_GEN_MB',
    'NIGHTGATE_SPONSOR_ALLOW_DEPLOY', 'NIGHTGATE_INSTANCE_ID'];
const saved: Record<string, string | undefined> = {};
let warnings: string[] = [];

beforeEach(() => {
    for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    __resetConfigForTests();
    warnings = [];
    setConfigWarnSink((m) => warnings.push(m));
});
afterEach(() => {
    for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    __resetConfigForTests();
});

describe('config table: parsing rules', () => {
    it('an empty value is unset: the default applies, never 0', () => {
        process.env.NIGHTGATE_PREWARM_STALL_MS = '';
        expect(configMs('NIGHTGATE_PREWARM_STALL_MS')).toBe(600000);
        process.env.NIGHTGATE_SAVE_INTERVAL_MS = '   ';
        expect(configMs('NIGHTGATE_SAVE_INTERVAL_MS')).toBe(60000);
        expect(warnings).toEqual([]);
    });

    it('a non-numeric value warns once and keeps the default (a mistyped timeout cannot fire immediately)', () => {
        process.env.NIGHTGATE_WORKER_RPC_TIMEOUT_MS = 'abc';
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(1800000);
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(1800000);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toMatch(/NIGHTGATE_WORKER_RPC_TIMEOUT_MS: 'abc' is not an integer/);
        expect(Number.isNaN(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS'))).toBe(false);
    });

    it('below the minimum is invalid (default), above the maximum is clamped, both with a warning', () => {
        process.env.NIGHTGATE_SAVE_INTERVAL_MS = '10';
        expect(configMs('NIGHTGATE_SAVE_INTERVAL_MS')).toBe(60000);
        process.env.NIGHTGATE_PREWARM_STALL_MS = '-5';
        expect(configMs('NIGHTGATE_PREWARM_STALL_MS')).toBe(600000);
        process.env.NIGHTGATE_WORKER_YOUNG_GEN_MB = '99999';
        expect(configNumber('NIGHTGATE_WORKER_YOUNG_GEN_MB')).toBe(2048);
        expect(warnings.some(w => /below the minimum/.test(w))).toBe(true);
        expect(warnings.some(w => /above the maximum/.test(w))).toBe(true);
    });

    it('booleans accept true/false, 1/0, yes/no, on/off and warn on anything else', () => {
        for (const [raw, want] of [['true', true], ['1', true], ['yes', true], ['ON', true], ['false', false], ['0', false], ['no', false], ['off', false]] as const) {
            process.env.NIGHTGATE_CRAWLER_ENABLED = raw;
            expect(configBool('NIGHTGATE_CRAWLER_ENABLED'), raw).toBe(want);
        }
        process.env.NIGHTGATE_CRAWLER_ENABLED = 'maybe';
        expect(configBool('NIGHTGATE_CRAWLER_ENABLED')).toBeUndefined();
        expect(warnings.at(-1)).toMatch(/is not a boolean/);
        delete process.env.NIGHTGATE_CRAWLER_ENABLED;
        expect(configBool('NIGHTGATE_CRAWLER_ENABLED')).toBeUndefined();   // tri-state: unset
        expect(configFlag('NIGHTGATE_SPONSOR_ALLOW_SWAPS')).toBe(false);   // defaulted
    });

    it('enums match case-insensitively and report the canonical spelling', () => {
        process.env.NIGHTGATE_PROVING_MODE = 'WASM';
        expect(configEnum('NIGHTGATE_PROVING_MODE')).toBe('wasm');
        process.env.NIGHTGATE_PROVING_MODE = 'gpu';
        expect(configEnum('NIGHTGATE_PROVING_MODE')).toBeUndefined();
        expect(warnings.at(-1)).toMatch(/is not one of server \| wasm/);
        process.env.NIGHTGATE_PROVING_MODE = 'Server';
        expect(configEnum('NIGHTGATE_PROVING_MODE')).toBe('server');
    });

    it('lists split on commas and drop blanks', () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS = ' a , ,b,';
        expect(configList('NIGHTGATE_FEE_SPONSOR_SESSIONS')).toEqual(['a', 'b']);
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSIONS;
        expect(configList('NIGHTGATE_FEE_SPONSOR_SESSIONS')).toEqual([]);
    });

    it('accessors refuse a key of another kind and an undeclared key', () => {
        expect(() => configString('NIGHTGATE_SAVE_INTERVAL_MS')).toThrow(/is a ms, not a string/);
        expect(() => configInt('NIGHTGATE_INSTANCE_ID')).toThrow(/not a number/);
        expect(() => configSpec('NIGHTGATE_NOT_A_KNOB')).toThrow(/not declared/);
    });

    it('an explicit env map is parsed under the same rules', () => {
        expect(configNumberFrom('NIGHTGATE_WORKER_YOUNG_GEN_MB', {})).toBe(128);
        expect(configNumberFrom('NIGHTGATE_WORKER_YOUNG_GEN_MB', { NIGHTGATE_WORKER_YOUNG_GEN_MB: 'abc' })).toBe(128);
        expect(configNumberFrom('NIGHTGATE_WORKER_YOUNG_GEN_MB', { NIGHTGATE_WORKER_YOUNG_GEN_MB: '256' })).toBe(256);
    });

    it('parseConfigValue handles CAP-typed values (number, boolean, array)', () => {
        expect(parseConfigValue(configSpec('NIGHTGATE_SIGNING_RATE_LIMIT'), 25).value).toBe(25);
        expect(parseConfigValue(configSpec('NIGHTGATE_CRAWLER_ENABLED'), false).value).toBe(false);
        expect(parseConfigValue(configSpec('NIGHTGATE_FEE_SPONSOR_SESSIONS'), ['x', ' y ']).value).toEqual(['x', 'y']);
    });
});

describe('config table: CAP mapping', () => {
    it('camelCase mapping rule', () => {
        expect(camelConfigKey('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe('workerRpcTimeoutMs');
        expect(camelConfigKey('NIGHTGATE_NETWORK')).toBe('network');
        expect(camelConfigKey('ENCRYPTION_KEY_ACTIVE')).toBe('encryptionKeyActive');
    });

    it('every setting has one CDS key: the one its text names, else the camel case of its variable', () => {
        const named = CONFIG_TABLE.filter(spec => spec.capKey !== undefined);
        expect(named.length).toBe(13);
        for (const spec of named) expect(spec.doc, spec.key).toContain('`' + spec.capKey + '`');
        // A text that says which CDS key a variable overrides must agree with the key the server reads.
        for (const spec of CONFIG_TABLE) {
            const override = /^Override `([A-Za-z0-9_.]+)`/.exec(spec.doc)?.[1];
            if (override) expect([spec.key, capConfigKey(spec)]).toEqual([spec.key, override]);
        }
        expect(new Set(CONFIG_TABLE.map(capConfigKey)).size).toBe(CONFIG_TABLE.length);
    });

    it('reads a setting from its one CDS key only, also where that key is nested', () => {
        const read = (overrides: Record<string, unknown>) => resolveConfigTable({}, overrides).values;
        expect(read({ crawler: { fetchConcurrency: 7, enabled: false } })).toMatchObject({ NIGHTGATE_CRAWLER_FETCH_CONCURRENCY: 7, NIGHTGATE_CRAWLER_ENABLED: false });
        expect(read({ feeSponsorSessions: ['s1', 's2'] }).NIGHTGATE_FEE_SPONSOR_SESSIONS).toEqual(['s1', 's2']);
        expect(read({ workerRpcTimeoutMs: 45000 }).NIGHTGATE_WORKER_RPC_TIMEOUT_MS).toBe(45000);
        // The camel case of the variable is no second spelling of a setting that has its own key.
        const former = read({ fetchConcurrency: 7, crawlerEnabled: false, feeSponsorSession: 's1' });
        expect([former.NIGHTGATE_CRAWLER_FETCH_CONCURRENCY, former.NIGHTGATE_CRAWLER_ENABLED, former.NIGHTGATE_FEE_SPONSOR_SESSIONS])
            .toEqual([undefined, undefined, undefined]);
        expect(capConfigValue({ crawler: 'not an object' }, 'crawler.enabled')).toBeUndefined();
        expect(capConfigValue(null, 'crawler.enabled')).toBeUndefined();
    });

    it('a renamed variable is not read under its former name, and a start can name it', () => {
        const renamed = CONFIG_TABLE.filter(spec => spec.formerKey !== undefined);
        expect(renamed.map(spec => [spec.formerKey, spec.key])).toEqual([
            ['NIGHTGATE_FETCH_CONCURRENCY', 'NIGHTGATE_CRAWLER_FETCH_CONCURRENCY'], ['NIGHTGATE_RPC_BATCH_SIZE', 'NIGHTGATE_CRAWLER_RPC_BATCH_SIZE'],
            ['NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS', 'NIGHTGATE_SUBMIT_INDEXER_VISIBLE_MS'], ['NIGHTGATE_SPONSOR_WAIT', 'NIGHTGATE_SUBMIT_WAIT'],
            ['NIGHTGATE_FEE_SPONSOR_SESSION', 'NIGHTGATE_FEE_SPONSOR_SESSIONS'], ['NIGHTGATE_SPONSOR_SWAP_MAX_INPUTS', 'NIGHTGATE_SPONSOR_MAX_INPUTS'],
            ['NIGHTGATE_SIGNING_KEY_RATE_LIMIT', 'NIGHTGATE_SIGNING_RATE_LIMIT']
        ].sort((a, b) => CONFIG_TABLE.findIndex(s => s.key === a[1]) - CONFIG_TABLE.findIndex(s => s.key === b[1])));
        // No former name is a current name of another setting.
        expect(renamed.filter(spec => CONFIG_TABLE.some(other => other.key === spec.formerKey))).toEqual([]);

        const read = (env: Record<string, string>, overrides?: Record<string, unknown>) => resolveConfigTable(env, overrides).values;
        expect(read({ NIGHTGATE_FEE_SPONSOR_SESSION: 's1,s2' }).NIGHTGATE_FEE_SPONSOR_SESSIONS).toBeUndefined();
        expect(read({ NIGHTGATE_FEE_SPONSOR_SESSION: 'old', NIGHTGATE_FEE_SPONSOR_SESSIONS: 'new' }).NIGHTGATE_FEE_SPONSOR_SESSIONS).toEqual(['new']);
        expect(read({ NIGHTGATE_SPONSOR_WAIT: 'finalized' }).NIGHTGATE_SUBMIT_WAIT).toBe('inblock');
        expect(read({}, { sponsorWait: 'finalized' }).NIGHTGATE_SUBMIT_WAIT).toBe('inblock');
        expect(formerCapKeys({ sponsorWait: 'finalized' })).toEqual([{ former: 'sponsorWait', now: 'submitWait' }]);
        expect(formerEnvKeys({ NIGHTGATE_SPONSOR_WAIT: 'finalized', NIGHTGATE_SUBMIT_WAIT: 'inblock', NIGHTGATE_FETCH_CONCURRENCY: ' ' }))
            .toEqual([{ former: 'NIGHTGATE_SPONSOR_WAIT', now: 'NIGHTGATE_SUBMIT_WAIT' }]);
    });

    it('the lifetime of a wallet session is a checked number, whatever form the configuration gives it', () => {
        const ttl = (env: Record<string, string>, overrides?: Record<string, unknown>) => resolveConfigTable(env, overrides).values.NIGHTGATE_SESSION_TTL_MS;
        expect(ttl({})).toBe(86_400_000);
        // Text from the CDS configuration used to be added to the clock as text, which broke connectWallet.
        expect(ttl({}, { sessionTtlMs: '3600000' })).toBe(3_600_000);
        expect(ttl({ NIGHTGATE_SESSION_TTL_MS: '120000' }, { sessionTtlMs: 3_600_000 })).toBe(120_000);
        // Below the minimum of one minute the default applies, with a warning.
        expect(ttl({}, { sessionTtlMs: 5 })).toBe(86_400_000);
        expect(ttl({}, { sessionTtlMs: 'soon' })).toBe(86_400_000);
    });

    it('names a setting written under a spelling the server does not read', () => {
        expect(formerCapKeys({ crawlerEnabled: false, fetchConcurrency: 7, workerRpcTimeoutMs: 1, crawler: { enabled: true } })).toEqual([
            { former: 'crawlerEnabled', now: 'crawler.enabled' }, { former: 'fetchConcurrency', now: 'crawler.fetchConcurrency' }
        ]);
        // The camel case of the renamed variable is no key of a setting that has its own key either.
        expect(formerCapKeys({ crawlerFetchConcurrency: 7, feeSponsorSession: 's1' })).toEqual([
            { former: 'crawlerFetchConcurrency', now: 'crawler.fetchConcurrency' }, { former: 'feeSponsorSession', now: 'feeSponsorSessions' }
        ]);
        expect(formerCapKeys({ crawler: { enabled: false }, feeSponsorSessions: 's1' })).toEqual([]);
        expect(formerCapKeys(undefined)).toEqual([]);
    });

    it('the CAP block sets a knob; the env variable wins; secrets are env only', () => {
        setConfigOverrideSource(() => ({ workerRpcTimeoutMs: 5000, encryptionKey: 'nope' }));
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(5000);
        expect(configIsSet('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(true);
        process.env.NIGHTGATE_WORKER_RPC_TIMEOUT_MS = '7000';
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(7000);
        expect(resolveConfigTable({}, { encryptionKey: 'nope' }).values.ENCRYPTION_KEY).toBeUndefined();
        expect(resolveConfigTable({}, { receiptSigningKey: 'a'.repeat(64) }).values.NIGHTGATE_RECEIPT_SIGNING_KEY).toBeUndefined();
    });
});

describe('config table: the worker reads the resolved snapshot, not its env', () => {
    it('a pinned snapshot answers every accessor and the env is ignored', () => {
        process.env.NIGHTGATE_SAVE_INTERVAL_MS = '20000';
        const snapshot = resolvedConfigSnapshot();
        expect(snapshot.NIGHTGATE_SAVE_INTERVAL_MS).toBe(20000);
        expect(Object.keys(snapshot)).not.toContain('ENCRYPTION_KEY');
        expect(Object.keys(snapshot)).not.toContain('ENCRYPTION_KEYS');
        pinResolvedConfig(snapshot);
        process.env.NIGHTGATE_SAVE_INTERVAL_MS = '30000';
        expect(configMs('NIGHTGATE_SAVE_INTERVAL_MS')).toBe(20000);
        // a key the (older) main thread did not send keeps its default
        pinResolvedConfig({ NIGHTGATE_SAVE_INTERVAL_MS: 20000 });
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(1800000);
    });
});

describe('config table: docs pinned to the table', () => {
    const repo = path.resolve(__dirname, '../..');

    it('docs/reference.md carries exactly the generated rows', () => {
        const doc = fs.readFileSync(path.join(repo, 'docs/reference.md'), 'utf8').replace(/\r\n/g, '\n');
        const start = doc.indexOf('<!-- config-table:start -->');
        const end = doc.indexOf('<!-- config-table:end -->');
        expect(start).toBeGreaterThan(0);
        const block = doc.slice(start, end).split('\n').filter(l => l.startsWith('| `'));
        expect(block).toEqual(configTableMarkdownRows());
    });

    it('every key is declared once and documented', () => {
        const keys = CONFIG_TABLE.map(s => s.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const spec of CONFIG_TABLE) expect(spec.doc.length, spec.key).toBeGreaterThan(10);
    });

    it('no source reads a NIGHTGATE_* variable past the table', () => {
        const offenders: string[] = [];
        const allowed = new Set(['srv/utils/nightgate-config.ts', 'src/index.ts']);
        const walk = (dir: string) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(full); continue; }
                if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
                const rel = path.relative(repo, full).replace(/\\/g, '/');
                if (allowed.has(rel)) continue;
                const text = fs.readFileSync(full, 'utf8');
                if (/process\.env\.NIGHTGATE_/.test(text)) offenders.push(rel);
            }
        };
        walk(path.join(repo, 'srv'));
        walk(path.join(repo, 'src'));
        expect(offenders).toEqual([]);
    });
});
