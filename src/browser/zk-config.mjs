// Browser ZK-config provider that fetches prover/verifier keys + zkir over HTTP
// from NIGHTGATE's `/zk-config/<contract>` route. Mirrors the layout
// the server-side NodeZkConfigProvider reads:
//   keys/<circuitId>.prover, keys/<circuitId>.verifier, zkir/<circuitId>.bzkir
//
// Extends the SDK's abstract ZKConfigProvider, so it inherits get() /
// getVerifierKeys() / asKeyMaterialProvider() for free. The last is exactly the
// `KeyMaterialProvider` the DApp-Connector's getProvingProvider() expects, so a
// single instance feeds BOTH proving modalities (self-prove via proofProvider,
// or wallet-delegated proving).

import {
    ZKConfigProvider,
    createProverKey,
    createVerifierKey,
    createZKIR
} from '@midnight-ntwrk/midnight-js-types';

export class FetchZkConfigProvider extends ZKConfigProvider {
    /**
     * @param {string} baseUrl  e.g. `https://host/zk-config/attestation-vault`
     *                          (the per-contract `zkConfigBaseUrl` from /contract-manifest)
     * @param {typeof fetch} [fetchFn]  injectable for tests; defaults to global fetch
     */
    constructor(baseUrl, fetchFn) {
        super();
        if (!baseUrl) throw new Error('FetchZkConfigProvider: baseUrl is required');
        this.baseUrl = String(baseUrl).replace(/\/+$/, '');
        this.fetchFn = fetchFn || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : undefined);
        if (!this.fetchFn) throw new Error('FetchZkConfigProvider: no fetch available; pass fetchFn');
    }

    async _bytes(subDir, circuitId, ext) {
        const url = `${this.baseUrl}/${subDir}/${circuitId}${ext}`;
        const res = await this.fetchFn(url);
        if (!res.ok) throw new Error(`FetchZkConfigProvider: ${url} -> HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
    }

    async getProverKey(circuitId) {
        return createProverKey(await this._bytes('keys', circuitId, '.prover'));
    }

    async getVerifierKey(circuitId) {
        return createVerifierKey(await this._bytes('keys', circuitId, '.verifier'));
    }

    async getZKIR(circuitId) {
        return createZKIR(await this._bytes('zkir', circuitId, '.bzkir'));
    }
}
