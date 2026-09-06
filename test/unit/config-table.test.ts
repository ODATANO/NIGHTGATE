/**
 * The typed config table (`srv/utils/config-table.ts` + `config.ts`): one
 * parser for every knob, the CAP mapping, the worker snapshot, and the docs
 * pinned to the table.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    CONFIG_TABLE, camelConfigKey, parseConfigValue, configSpec, configTableMarkdownRows, resolveConfigTable
} from '../../srv/utils/config-table';
import {
    __resetConfigForTests, configMs, configNumber, configInt, configBool, configFlag, configString, configEnum, configList,
    configIsSet, pinResolvedConfig, resolvedConfigSnapshot, setConfigOverrideSource, setConfigWarnSink, configNumberFrom
} from '../../srv/utils/config';

const KEYS = ['NIGHTGATE_WORKER_RPC_TIMEOUT_MS', 'NIGHTGATE_SAVE_INTERVAL_MS', 'NIGHTGATE_CRAWLER_ENABLED', 'NIGHTGATE_PROVING_MODE',
    'NIGHTGATE_FEE_SPONSOR_SESSION', 'NIGHTGATE_PREWARM_STALL_MS', 'NIGHTGATE_SIGNING_KEY_RATE_LIMIT', 'NIGHTGATE_WORKER_YOUNG_GEN_MB',
    'NIGHTGATE_SPONSOR_ALLOW_DEPLOY', 'NIGHTGATE_STATUS_ROUTES', 'NIGHTGATE_INSTANCE_ID'];
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
        expect(configFlag('NIGHTGATE_SPONSOR_ALLOW_DEPLOY')).toBe(false);   // defaulted
    });

    it('enums match case-insensitively and report the canonical spelling', () => {
        process.env.NIGHTGATE_PROVING_MODE = 'WASM';
        expect(configEnum('NIGHTGATE_PROVING_MODE')).toBe('wasm');
        process.env.NIGHTGATE_PROVING_MODE = 'gpu';
        expect(configEnum('NIGHTGATE_PROVING_MODE')).toBeUndefined();
        expect(warnings.at(-1)).toMatch(/is not one of server \| wasm/);
        process.env.NIGHTGATE_STATUS_ROUTES = 'Public';
        expect(configEnum('NIGHTGATE_STATUS_ROUTES')).toBe('public');
    });

    it('lists split on commas and drop blanks', () => {
        process.env.NIGHTGATE_FEE_SPONSOR_SESSION = ' a , ,b,';
        expect(configList('NIGHTGATE_FEE_SPONSOR_SESSION')).toEqual(['a', 'b']);
        delete process.env.NIGHTGATE_FEE_SPONSOR_SESSION;
        expect(configList('NIGHTGATE_FEE_SPONSOR_SESSION')).toEqual([]);
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
        expect(parseConfigValue(configSpec('NIGHTGATE_SIGNING_KEY_RATE_LIMIT'), 25).value).toBe(25);
        expect(parseConfigValue(configSpec('NIGHTGATE_CRAWLER_ENABLED'), false).value).toBe(false);
        expect(parseConfigValue(configSpec('NIGHTGATE_FEE_SPONSOR_SESSION'), ['x', ' y ']).value).toEqual(['x', 'y']);
    });
});

describe('config table: CAP mapping', () => {
    it('camelCase mapping rule', () => {
        expect(camelConfigKey('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe('workerRpcTimeoutMs');
        expect(camelConfigKey('NIGHTGATE_NETWORK')).toBe('network');
        expect(camelConfigKey('ENCRYPTION_KEY_ACTIVE')).toBe('encryptionKeyActive');
    });

    it('the CAP block sets a knob; the env variable wins; secrets are env only', () => {
        setConfigOverrideSource(() => ({ workerRpcTimeoutMs: 5000, encryptionKey: 'nope' }));
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(5000);
        expect(configIsSet('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(true);
        process.env.NIGHTGATE_WORKER_RPC_TIMEOUT_MS = '7000';
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(7000);
        expect(resolveConfigTable({}, { encryptionKey: 'nope' }).values.ENCRYPTION_KEY).toBeUndefined();
    });
});

describe('config table: the worker reads the resolved snapshot, not its env', () => {
    it('a pinned snapshot answers every accessor and the env is ignored', () => {
        process.env.NIGHTGATE_SAVE_INTERVAL_MS = '20000';
        const snapshot = resolvedConfigSnapshot();
        expect(snapshot.NIGHTGATE_SAVE_INTERVAL_MS).toBe(20000);
        expect(Object.keys(snapshot)).not.toContain('ENCRYPTION_KEY');
        expect(Object.keys(snapshot)).not.toContain('NIGHTGATE_STATUS_TOKEN');
        pinResolvedConfig(snapshot);
        process.env.NIGHTGATE_SAVE_INTERVAL_MS = '30000';
        expect(configMs('NIGHTGATE_SAVE_INTERVAL_MS')).toBe(20000);
        // a key the (older) main thread did not send keeps its default
        pinResolvedConfig({ NIGHTGATE_SAVE_INTERVAL_MS: 20000 });
        expect(configMs('NIGHTGATE_WORKER_RPC_TIMEOUT_MS')).toBe(1800000);
    });
});

describe('config table: docs and plugin schema pinned to the table', () => {
    const repo = path.resolve(__dirname, '../..');

    it('docs/reference.md carries exactly the generated rows', () => {
        const doc = fs.readFileSync(path.join(repo, 'docs/reference.md'), 'utf8').replace(/\r\n/g, '\n');
        const start = doc.indexOf('<!-- config-table:start -->');
        const end = doc.indexOf('<!-- config-table:end -->');
        expect(start).toBeGreaterThan(0);
        const block = doc.slice(start, end).split('\n').filter(l => l.startsWith('| `'));
        expect(block).toEqual(configTableMarkdownRows());
    });

    it('every key is declared once, documented, and every env name src/plugin.ts advertises exists', () => {
        const keys = CONFIG_TABLE.map(s => s.key);
        expect(new Set(keys).size).toBe(keys.length);
        for (const spec of CONFIG_TABLE) expect(spec.doc.length, spec.key).toBeGreaterThan(10);
        const plugin = fs.readFileSync(path.join(repo, 'src/plugin.ts'), 'utf8');
        for (const name of new Set(plugin.match(/NIGHTGATE_[A-Z_0-9]+/g) ?? [])) {
            expect(keys, name).toContain(name);
        }
    });

    it('no plugin source reads a NIGHTGATE_* variable past the table', () => {
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
