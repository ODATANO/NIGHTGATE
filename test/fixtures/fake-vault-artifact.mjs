/**
 * Minimal stand-in for a compiled AttestationVault artifact's `contract/index.js`.
 * Only the `ledger(state)` decoder is modeled: it interprets the (test-supplied)
 * state as plain objects keyed by lowercase hex and exposes the Compact
 * `Map`-style `member(bytes)` / `lookup(bytes)` views the state readers use.
 * Loaded through the same `pathToFileURL(artifactPath)` native import as a real
 * artifact, so the wrapper's artifact-loading path is exercised for real.
 */
function hex(bytes) {
    return Buffer.from(bytes).toString('hex');
}

function mapView(obj = {}) {
    return {
        member(key) {
            return Object.prototype.hasOwnProperty.call(obj, hex(key));
        },
        lookup(key) {
            return obj[hex(key)];
        }
    };
}

export function ledger(state) {
    return {
        public_attestations: mapView(state.public_attestations),
        attestation_owners: mapView(state.attestation_owners),
        content_roots: mapView(state.content_roots),
        predicate_results: mapView(state.predicate_results),
        field_predicate_results: mapView(state.field_predicate_results)
    };
}
