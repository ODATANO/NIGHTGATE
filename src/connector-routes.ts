import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import type { Request, Response } from 'express';

import { getNightgatePluginConfig, getConfiguredNightgateNetwork, DEFAULT_NETWORK } from '../srv/utils/nightgate-config';
import { getContractRegistration, listRegisteredContracts } from '../srv/submission/contract-registry';
import { configString } from '../srv/utils/config';
import { ZK_ARTIFACT_MANIFEST_DIR, ZK_ARTIFACT_MANIFEST_FILE, hasZkArtifactManifest } from '../srv/submission/zk-artifact-manifest';

// HTTP routes that browser apps use to load proving files and the contract list.
// HTTP security and CORS are left to the host app.

// The URLs follow the folder layout on disk. Only registered contracts are served.
const ZK_FILE_RE = /^([A-Za-z0-9_]+\.(prover|verifier|zkir|bzkir)|manifest\.json)$/;
// Prover keys are large, so a file is hashed again only when its mtime or size changes.
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

function listZkFiles(zkConfigPath: string, dir: 'keys' | 'zkir'): string[] {
    try {
        return fs.readdirSync(path.join(zkConfigPath, dir)).filter(f => ZK_FILE_RE.test(f)).sort();
    } catch { return []; }
}

/** The part of an express app the routes need. */
export interface RouteApp {
    get(path: string | string[], handler: (req: Request, res: Response) => void): unknown;
}

export function mountZkConfigRoute(app: RouteApp): void {
    // The bare contract path lists what is served below it.
    app.get(['/zk-config/:contract', '/zk-config/:contract/'], (req: Request, res: Response) => {
        const contract = String(req.params.contract);
        const reg = getContractRegistration(contract);
        if (!reg) { res.status(404).end(); return; }
        res.setHeader('Cache-Control', 'public, no-cache');
        res.json({
            contract,
            circuits: listContractCircuits(reg.zkConfigPath),
            files: {
                keys: listZkFiles(reg.zkConfigPath, 'keys'),
                zkir: listZkFiles(reg.zkConfigPath, 'zkir'),
                ...(hasZkArtifactManifest(reg.zkConfigPath) ? { [ZK_ARTIFACT_MANIFEST_DIR]: [ZK_ARTIFACT_MANIFEST_FILE] } : {})
            }
        });
    });

    app.get('/zk-config/:contract/:dir/:file', (req: Request, res: Response) => {
        const contract = String(req.params.contract);
        const dir = String(req.params.dir);
        const file = String(req.params.file);
        const served = dir === ZK_ARTIFACT_MANIFEST_DIR
            ? file === ZK_ARTIFACT_MANIFEST_FILE
            : (dir === 'keys' || dir === 'zkir') && ZK_FILE_RE.test(file);
        if (!served) {
            res.status(404).end();
            return;
        }
        const reg = getContractRegistration(contract);
        if (!reg) { res.status(404).end(); return; }
        const baseDir = path.resolve(reg.zkConfigPath, dir);
        const absPath = path.resolve(baseDir, file);
        // Refuse paths that leave the contract's folder.
        if (!absPath.startsWith(baseDir + path.sep)) { res.status(404).end(); return; }
        const etag = zkFileEtag(absPath);
        if (!etag) { res.status(404).end(); return; }
        res.setHeader('ETag', etag);
        // Not cached forever, because a contract upgrade serves new keys under the same path.
        res.setHeader('Cache-Control', 'public, no-cache');
        res.setHeader('Content-Type', file.endsWith('.json') ? 'application/json' : 'application/octet-stream');
        if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
        fs.createReadStream(absPath)
            .on('error', () => { if (!res.headersSent) res.status(500).end(); })
            .pipe(res);
    });
}

// Contracts this package also exports for the browser as `@odatano/nightgate/browser/<name>`.
const BROWSER_EXPORTED = new Set(['attestation-vault', 'attestation-vault-32']);

function listContractCircuits(zkConfigPath: string): string[] {
    try {
        return fs.readdirSync(path.join(zkConfigPath, 'keys'))
            .filter(f => f.endsWith('.verifier'))
            .map(f => f.slice(0, -'.verifier'.length))
            .sort();
    } catch { return []; }
}

// Lists registered contracts. Addresses are included only when set in the config.
export function mountContractManifestRoute(app: RouteApp): void {
    app.get('/contract-manifest', (_req: Request, res: Response) => {
        const cfg = getNightgatePluginConfig();
        const network = getConfiguredNightgateNetwork(cfg) || DEFAULT_NETWORK;
        // Without a configured base URL the links are relative. The Host header is never used.
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
