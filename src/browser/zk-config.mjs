// Loads the proving files of a contract over HTTP from the server's `/zk-config/<contract>` route.
// The file layout is the same as on the server:
//   keys/<circuitId>.prover, keys/<circuitId>.verifier, zkir/<circuitId>.bzkir
//
// One instance serves both proving modes: proving in the page and proving in the wallet.
// The wallet uses the asKeyMaterialProvider() view inherited from the SDK base class.

import {
    ZKConfigProvider,
    createProverKey,
    createVerifierKey,
    createZKIR
} from '@midnight-ntwrk/midnight-js-types';

export class FetchZkConfigProvider extends ZKConfigProvider {
    /**
     * @param {string} baseUrl  The contract's `zkConfigBaseUrl` from /contract-manifest,
     *                          for example `https://host/zk-config/attestation-vault`.
     * @param {typeof fetch} [fetchFn]  Defaults to the global fetch.
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
