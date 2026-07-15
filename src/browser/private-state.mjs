// In-memory PrivateStateProvider for the browser/connector path.
//
// The AttestationVault has NO contract private state (all
// ledger is public; witnesses pass ctx.privateState through unchanged). So a
// trivial in-memory provider is sufficient: nothing is persisted server-side
// and there is no secret to seed. It implements the full midnight-js
// PrivateStateProvider surface so findDeployedContract/callTx is satisfied.
//
// Export/import + signing-key persistence are no-ops / minimal: a wallet-driven
// call does not rely on durable contract private state for this contract family.

export class InMemoryPrivateStateProvider {
    constructor() {
        this._states = new Map();
        this._signingKeys = new Map();
        this._contractAddress = undefined;
    }

    setContractAddress(address) { this._contractAddress = address; }

    async set(privateStateId, state) { this._states.set(privateStateId, state); }
    async get(privateStateId) { return this._states.has(privateStateId) ? this._states.get(privateStateId) : null; }
    async remove(privateStateId) { this._states.delete(privateStateId); }
    async clear() { this._states.clear(); }

    async setSigningKey(address, signingKey) { this._signingKeys.set(address, signingKey); }
    async getSigningKey(address) { return this._signingKeys.has(address) ? this._signingKeys.get(address) : null; }
    async removeSigningKey(address) { this._signingKeys.delete(address); }
    async clearSigningKeys() { this._signingKeys.clear(); }

    async exportPrivateStates() { return { privateStates: {}, contractStates: {} }; }
    async importPrivateStates() { return { imported: [], skipped: [], errors: [] }; }
    async exportSigningKeys() { return { signingKeys: {} }; }
    async importSigningKeys() { return { imported: [], skipped: [], errors: [] }; }
}
