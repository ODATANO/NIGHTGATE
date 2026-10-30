// Loads a contract's proving files over HTTP from the server's `/zk-config/<contract>` route.
// One instance serves proving in the page and, through asKeyMaterialProvider(), proving in the wallet.

import {
    ZKConfigProvider,
    createProverKey,
    createVerifierKey,
    createZKIR
} from '@midnight-ntwrk/midnight-js-types';

export class FetchZkConfigProvider extends ZKConfigProvider {
    /** @param {string} baseUrl  The contract's `zkConfigBaseUrl` from /contract-manifest. */
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
