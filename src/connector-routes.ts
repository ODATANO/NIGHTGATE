import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import { getNightgatePluginConfig, getConfiguredNightgateNetwork, DEFAULT_NETWORK } from '../srv/utils/nightgate-config';
import { getContractRegistration, listRegisteredContracts } from '../srv/submission/contract-registry';
import { configString } from '../srv/utils/config';

// Browser connector routes (/zk-config, /contract-manifest). HTTP security and
// CORS belong to the consuming CAP host.

// URL layout mirrors the on-disk zk config, so a fetch provider at
// `<server>/zk-config/<contract>` resolves it. Only registered contracts are servable.
const ZK_FILE_RE = /^([A-Za-z0-9_]+\.(prover|verifier|zkir|bzkir)|manifest\.json)$/;
// Keyed by (mtime, size): large prover keys are hashed once per generation.
const zkEtagCache = new Map<string, { mtimeMs: number; size: number; etag: string }>();

export function zkFileEtag(absPath: string): string | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); } catch { return null; }
    const cached = zkEtagCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.etag;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    const etag = `"${hash}"`;
    zkEtagCache.set(absPath, { mtimeMs: stat.mtimeMs, size: stat.size, etag });
    return etag;
}

export function mountZkConfigRoute(app: any): void {
    app.get('/zk-config/:contract/:dir/:file', (req: any, res: any) => {
            const { contract, dir, file } = req.params;
            if ((dir !== 'keys' && dir !== 'zkir') || !ZK_FILE_RE.test(file)) {
                res.status(404).end();
                return;
            }
            const reg = getContractRegistration(contract);
            if (!reg) { res.status(404).end(); return; }
            const baseDir = path.resolve(reg.zkConfigPath, dir);
            const absPath = path.resolve(baseDir, file);
            // Path-traversal guard (defence in depth; the regex already bars `/`/`..`).
            if (!absPath.startsWith(baseDir + path.sep)) { res.status(404).end(); return; }
            const etag = zkFileEtag(absPath);
            if (!etag) { res.status(404).end(); return; }
            res.setHeader('ETag', etag);
            // Not immutable: the same path serves different keys after an upgrade.
            res.setHeader('Cache-Control', 'public, no-cache');
            res.setHeader('Content-Type', 'application/octet-stream');
            if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
            fs.createReadStream(absPath)
                .on('error', () => { if (!res.headersSent) res.status(500).end(); })
                .pipe(res);
    });
}

// Contracts that ship a browser artifact export (`@odatano/nightgate/browser/<name>`).
const BROWSER_EXPORTED = new Set(['attestation-vault', 'attestation-vault-32']);

function listContractCircuits(zkConfigPath: string): string[] {
    try {
        return fs.readdirSync(path.join(zkConfigPath, 'keys'))
            .filter(f => f.endsWith('.verifier'))
            .map(f => f.slice(0, -'.verifier'.length))
            .sort();
    } catch { return []; }
}

// Registered contracts only; addresses only when pinned in config.
export function mountContractManifestRoute(app: any): void {
    app.get('/contract-manifest', (req: any, res: any) => {
        const cfg = getNightgatePluginConfig();
        const network = getConfiguredNightgateNetwork(cfg) || DEFAULT_NETWORK;
        // No configured base: relative URLs, never reflect the Host header.
        const base = (configString('NIGHTGATE_ZK_CONFIG_PUBLIC_URL') ?? '').replace(/\/+$/, '');
        const contracts = listRegisteredContracts().map((name: string) => {
            const reg = getContractRegistration(name);
            if (!reg) return null;
            const etag = zkFileEtag(reg.artifactPath);
            const cfgAddr = cfg.contracts?.[name]?.address;
            const addresses = cfgAddr == null ? [] : (Array.isArray(cfgAddr) ? cfgAddr : [cfgAddr]);
            const entry: Record<string, unknown> = {
                name,
                zkConfigBaseUrl: `${base}/zk-config/${name}`,
                circuits: listContractCircuits(reg.zkConfigPath),
                artifactHash: etag ? etag.replace(/"/g, '') : null
            };
            if (BROWSER_EXPORTED.has(name)) entry.artifactRef = `@odatano/nightgate/browser/${name}`;
            if (addresses.length) entry.addresses = addresses;
            return entry;
        }).filter(Boolean);
        res.json({ network, zkConfigBaseUrl: `${base}/zk-config`, contracts });
    });
}
