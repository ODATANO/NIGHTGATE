/**
 * Minimal stand-in for a compiled AttestationVault artifact's `contract/index.js`.
 * Only the `ledger(state)` decoder is modeled: it interprets the (test-supplied)
 * state as plain objects keyed by lowercase hex and exposes the Compact
 * `Map`-style `member(bytes)` / `lookup(bytes)` views the state readers use.
 * Loaded through the same `pathToFileURL(artifactPath)` native import as a real
 * artifact, so the wrapper's artifact-loading path is exercised for real.
 *
 * Ledger shape (lineage 4): `attestations` (record key -> record struct),
 * `content_anchors` (record key -> { root, schema }), `claims` (claim key ->
 * valid_until bigint), `disclosures`, `document_bindings` (document id ->
 * record key), `document_owners` (document id -> registered attester).
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
        },
        [Symbol.iterator]() {
            return Object.entries(obj).map(([k, v]) => [Buffer.from(k, 'hex'), v])[Symbol.iterator]();
        }
    };
}

export function ledger(state) {
    return {
        attestations: mapView(state.attestations),
        content_anchors: mapView(state.content_anchors),
        claims: mapView(state.claims),
        disclosures: mapView(state.disclosures),
        document_bindings: mapView(state.document_bindings),
        document_owners: mapView(state.document_owners)
    };
}
