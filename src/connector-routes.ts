import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

import { getNightgatePluginConfig, getConfiguredNightgateNetwork, DEFAULT_NETWORK } from '../srv/utils/nightgate-config';
import { getContractRegistration, listRegisteredContracts } from '../srv/submission/contract-registry';

// Browser DApp-connector HTTP surface. Two routes:
//   GET /zk-config/<contract>/<dir>/<file>  -> serve proving artifacts
//   GET /contract-manifest                  -> self-configuration manifest
//
// Extracted from plugin.ts so the handlers can be mounted on a bare Express
// app for testing (scripts/integration-test-connector-routes.mjs) without
// pulling in the plugin's cds lifecycle hooks. plugin.ts mounts both inside
// its single `cds.on('bootstrap')` listener, after the security-header
// middleware (which supplies CORS + CSP + nosniff).

// Serves a registered contract's ZK config (prover/verifier keys + zkir) over
// HTTP so browser consumers can use a FetchZkConfigProvider, and the wallet
// connector's `getProvingProvider(keyMaterialProvider)`. The URL layout mirrors
// the on-disk one the server-side NodeZkConfigProvider reads, so a fetch
// provider pointed at `<server>/zk-config/<contract>` resolves
// `keys/<circuit>.{prover,verifier}` and `zkir/<circuit>.{zkir,bzkir}` directly.
// Only REGISTERED contracts are servable; the registry is the security
// boundary.
const ZK_FILE_RE = /^[A-Za-z0-9_]+\.(prover|verifier|zkir|bzkir)$/;
const zkEtagCache = new Map<string, { mtimeMs: number; etag: string }>();

export function zkFileEtag(absPath: string): string | null {
    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); } catch { return null; }
    const cached = zkEtagCache.get(absPath);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.etag;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
    const etag = `"${hash}"`;
    zkEtagCache.set(absPath, { mtimeMs: stat.mtimeMs, etag });
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
            // Path-traversal guard (defence-in-depth; the regex already bars `/`/`..`).
            if (!absPath.startsWith(baseDir + path.sep)) { res.status(404).end(); return; }
            const etag = zkFileEtag(absPath);
            if (!etag) { res.status(404).end(); return; }
            res.setHeader('ETag', etag);
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            res.setHeader('Content-Type', 'application/octet-stream');
            if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
            fs.createReadStream(absPath)
                .on('error', () => { if (!res.headersSent) res.status(500).end(); })
                .pipe(res);
    });
}

// Contracts that ship a browser artifact export (`@odatano/nightgate/browser/<name>`).
const BROWSER_EXPORTED = new Set(['attestation-vault']);

// Circuit names = the `<circuit>.verifier` files in the contract's keys/ dir.
function listContractCircuits(zkConfigPath: string): string[] {
    try {
        return fs.readdirSync(path.join(zkConfigPath, 'keys'))
            .filter(f => f.endsWith('.verifier'))
            .map(f => f.slice(0, -'.verifier'.length))
            .sort();
    } catch { return []; }
}

// Self-configuration endpoint: lets a connector consumer discover the network,
// the zk-config base URL, and per-contract artifact ref / circuits / hash,
// without hard-coding any of it. Only REGISTERED contracts are listed.
// `address(es)` is advertised only when an operator pins it in config; the
// deployed address is otherwise per-deployment and caller-supplied.
export function mountContractManifestRoute(app: any): void {
    app.get('/contract-manifest', (req: any, res: any) => {
        const cfg = getNightgatePluginConfig();
        const network = getConfiguredNightgateNetwork(cfg) || DEFAULT_NETWORK;
        const base = (process.env.NIGHTGATE_ZK_CONFIG_PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
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
