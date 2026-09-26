/**
 * Every environment knob with kind, default and bounds. Empty = unset; an unparseable value or one
 * below `min` warns and takes the default (never NaN); above `max` is clamped. Env wins over the CAP
 * `<camelCase>` key, which wins over the default. No cds import: the worker loads this module.
 */

export type ConfigKind = 'int' | 'ms' | 'bool' | 'string' | 'enum' | 'list' | 'url' | 'path' | 'secret';

export interface ConfigSpec {
    key: string;
    kind: ConfigKind;
    /** Applies when the variable is unset or unparseable; `undefined` = no default. */
    default?: number | string | boolean;
    min?: number;
    max?: number;
    /** `enum` only: accepted values (matched case-insensitively, reported in this spelling). */
    values?: readonly string[];
    /** Read inside the wallet worker: travels in the resolved snapshot. */
    worker?: boolean;
    /** One line for docs/reference.md. */
    doc: string;
}

export type ConfigValue = number | string | boolean | string[] | undefined;

/** `NIGHTGATE_WORKER_RPC_TIMEOUT_MS` -> `workerRpcTimeoutMs`; `ENCRYPTION_KEY` -> `encryptionKey`. */
export function camelConfigKey(key: string): string {
    const parts = key.replace(/^NIGHTGATE_/, '').toLowerCase().split('_');
    return parts[0] + parts.slice(1).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

export const CONFIG_TABLE: readonly ConfigSpec[] = [
    { key: 'NIGHTGATE_NETWORK', kind: 'enum', values: ['preview', 'testnet', 'preprod', 'mainnet', 'undeployed'], doc: 'Override `network`' },
    { key: 'NIGHTGATE_NODE_URL', kind: 'url', doc: 'Override `nodeUrl`' },
    { key: 'NIGHTGATE_CRAWLER_NODE_URL', kind: 'url', doc: 'Override `crawler.nodeUrl`' },
    { key: 'NIGHTGATE_INDEXER_HTTP_URL', kind: 'url', doc: 'Override `indexerHttpUrl` (e.g. point at local indexer container)' },
    { key: 'NIGHTGATE_INDEXER_WS_URL', kind: 'url', doc: 'Override `indexerWsUrl`; optional, derived from the HTTP URL when unset' },
    { key: 'NIGHTGATE_PROOF_SERVER_URL', kind: 'url', doc: 'Override `proofServerUrl`' },
    { key: 'NIGHTGATE_PROVING_MODE', kind: 'enum', values: ['server', 'wasm'], worker: true, doc: 'Proving mode `wasm` (in-process) or `server` (proof server). Unset: `server` when a proof server is configured, `wasm` otherwise. `initialize()` pins the effective value into the env for the worker.' },
    { key: 'NIGHTGATE_PROOF_TIMEOUT_MS', kind: 'ms', default: 300000, min: 1, worker: true, doc: 'Override `proofTimeoutMs`; pinned into the env at plugin init for the wallet worker. The proof-server container has its own job TTL (`MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT`, default 600 s): raise both, or a finished-but-expired job answers 5xx and midnight-js re-proves.' },
    { key: 'NIGHTGATE_ZK_CONFIG_BASE', kind: 'path', default: './contracts', doc: 'Override `zkConfigBasePath`' },
    { key: 'NIGHTGATE_ZK_CONFIG_PUBLIC_URL', kind: 'url', doc: 'Public base URL advertised by `/contract-manifest` for the `/zk-config/...` routes (behind a reverse proxy); unset = relative URLs, resolved by the client against the origin it fetched the manifest from' },
    { key: 'NIGHTGATE_ZK_ASSET_URL', kind: 'string', doc: 'A `/zk-config` base the server fetches missing prover keys from (`<url>/<contract>/keys/<circuit>.prover`, verified against `keys/manifest.json`); `none`/`off` disables the fetch. Unset: the release tag on raw.githubusercontent.com for the shipped contracts, no source for others. Offline installs run `nightgate-fetch-keys` once.' },
    { key: 'NIGHTGATE_CONTRACTS_DIR', kind: 'string', doc: "Root directories (path-delimiter separated) a runtime `registerContract` (admin) may point into; default: the package's and the working directory's `contracts/`. Importing an artifact executes its module, so paths outside are refused. The supported way to keep a consumer's artifacts outside the package: point it at that directory. The artifact's `@midnight-ntwrk/compact-runtime` import resolves from NIGHTGATE's own node_modules (worker snapshots and the registration probe), so the directory needs no node_modules of its own." },
    { key: 'NIGHTGATE_PRIVATE_STATE_BACKEND', kind: 'enum', values: ['cap-db', 'level'], doc: 'Override `privateStateBackend`' },
    { key: 'NIGHTGATE_GRANTEE_BINDING', kind: 'enum', values: ['wallet', 'did', 'custom'], doc: 'Override `granteeBinding` (`wallet` / `did` / `custom`)' },
    { key: 'NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION', kind: 'bool', doc: 'Override `allowSelfServiceGranteeRegistration` (`false` / `0` / `no` / `off` disables)' },
    { key: 'NIGHTGATE_CLOSE_SESSIONS_ON_RESTART', kind: 'bool', doc: 'Override `closeSessionsOnRestart` (default on): `false` keeps the previous process\'s wallet sessions open across a restart' },
    { key: 'NIGHTGATE_INSTANCE_ID', kind: 'string', doc: 'Stable operator-provided instance identifier; otherwise CF instance GUID, hostname, or a generated UUID' },
    { key: 'NIGHTGATE_REPLICA_COUNT', kind: 'int', min: 1, doc: 'Actual process/replica count. Must be `1`; takes precedence over CDS `replicaCount`' },
    { key: 'NIGHTGATE_ALLOW_PRODUCTION_SQLITE', kind: 'bool', default: false, doc: '`true` temporarily permits production SQLite with a high-severity warning; intended only for a migration window' },
    { key: 'NIGHTGATE_ASSUME_DB_NETWORK', kind: 'string', doc: 'Confirms which network an index without a recorded network id belongs to; the boot guard refuses to bind such an index to the configured network otherwise.' },
    { key: 'NIGHTGATE_DEBUG_WALLET_SYNC', kind: 'bool', default: false, doc: '`true` logs wallet sync-state persistence at debug level' },
    { key: 'NIGHTGATE_CRAWLER_ENABLED', kind: 'bool', doc: '`false` / `0` / `no` / `off` disables the crawler at boot' },
    { key: 'NIGHTGATE_FETCH_CONCURRENCY', kind: 'int', min: 1, doc: 'Override `crawler.fetchConcurrency`' },
    { key: 'NIGHTGATE_RPC_BATCH_SIZE', kind: 'int', min: 1, doc: 'Override `crawler.rpcBatchSize`' },
    { key: 'NIGHTGATE_CRAWLER_START_HEIGHT', kind: 'int', min: 1, doc: 'Override `crawler.startHeight`: first height to index while the index is EMPTY (the block below it is indexed as the parentless anchor). Ignored once the index holds blocks, so a restart resumes at the cursor.' },
    { key: 'NIGHTGATE_CRAWLER_MAX_BPS', kind: 'int', min: 1, doc: 'Override `crawler.maxBlocksPerSecond`: catch-up rate cap, so block ingestion can share a host with the submission side. Unset = unlimited.' },
    { key: 'NIGHTGATE_CRAWLER_FAULT_GUARD', kind: 'bool', doc: '`false` lets a node transport fault shut the server down again, as CAP does by default. On by default: the crawler retries such a fault on its own, and taking the process down costs every sponsor facade its warm-up. Absorbed faults are counted in `getMetrics()`.' },
    { key: 'NIGHTGATE_CRAWLER_DECODE_PAYLOADS', kind: 'bool', doc: 'Override `crawler.decodePayloads`: decode stored ledger payloads in a pass behind the indexed tip (circuit names, transaction identifiers, zswap and DUST counts). Off by default; the decode runs in wasm on the main thread.' },
    { key: 'NIGHTGATE_CRAWLER_INDEXER_SUPPLEMENT', kind: 'bool', doc: 'Override `crawler.indexerSupplement`: fill what a block does not carry (segments, contract state and balances, ledger-event streams, the DUST registration flag) from the Midnight indexer, in a pass behind the indexed tip. Off by default; it makes the index depend on a second source.' },
    { key: 'NIGHTGATE_CRAWLER_INDEXER_URL', kind: 'url', doc: 'Override `crawler.indexerUrl`: the GraphQL endpoint the supplement pass reads. Default: the submission side\'s indexer (`NIGHTGATE_INDEXER_HTTP_URL`). A private indexer here keeps the pass off the public one, whose edge blocks the whole host IP under load, sponsor facades included.' },
    { key: 'NIGHTGATE_CRAWLER_SUPPLEMENT_MAX_BPS', kind: 'int', min: 1, doc: 'Override `crawler.supplementBlocksPerSecond` (default 2): indexer requests per second of the supplement pass, one per block, paced per request. The public indexers block the whole host IP (403 from their load balancer, also for the sponsor facades) at roughly 15 per second; on a 403 or 429 the pass backs off for one minute, doubling up to fifteen.' },
    { key: 'NIGHTGATE_JOB_LEASE_TTL_MS', kind: 'ms', default: 300000, min: 1, doc: 'A `running` job whose heartbeat is older than this is reclaimed (re-dispatched with `attempt + 1`) unless it crossed the external-effect boundary; default 5 minutes.' },
    { key: 'NIGHTGATE_CHILD_JOB_WAIT_TIMEOUT_MS', kind: 'ms', min: 1, doc: 'Parent-workflow watchdog; defaults to the worker RPC timeout plus 5 minutes. Timeout is fail-closed while the child may continue.' },
    { key: 'NIGHTGATE_WORKER_RPC_TIMEOUT_MS', kind: 'ms', default: 1800000, min: 1, doc: 'Backstop timeout of one wallet-worker RPC (a proof or a submit); default 30 minutes.' },
    { key: 'NIGHTGATE_WORKER_DRAIN_MAX_MS', kind: 'ms', default: 600000, min: 1, doc: 'Upper bound of a worker rotation drain (in-flight submits complete first); default 10 minutes, then the worker is terminated and the cut calls fail `WORKER_ROTATED`.' },
    { key: 'NIGHTGATE_WORKER_YOUNG_GEN_MB', kind: 'int', default: 128, min: 0, max: 2048, doc: 'Young-generation size of the wallet worker thread (`resourceLimits.maxYoungGenerationSizeMb`); default 128, `0` = V8 default, clamped to 16..2048.' },
    { key: 'NIGHTGATE_WORKER_MAX_GENERATIONS', kind: 'int', default: 32, min: 0, worker: true, doc: 'Distinct artifact generations a worker loads before it rotates (drain + fresh thread); default 32.' },
    { key: 'NIGHTGATE_WORKER_GENERATION_CACHE', kind: 'int', default: 8, min: 1, worker: true, doc: 'Scaffold and provider cache size per worker (bounded cache of artifact generations); default 8.' },
    { key: 'NIGHTGATE_ARTIFACT_SNAPSHOT_DIR', kind: 'path', worker: true, doc: 'Base directory of the immutable content-addressed artifact snapshots the worker proves from; default `<tmpdir>/nightgate-artifact-snapshots`, layout `<base>/<install>/<digest>`.' },
    { key: 'NIGHTGATE_ARTIFACT_SNAPSHOT_TTL_DAYS', kind: 'int', default: 14, min: 0, worker: true, doc: 'Snapshots no live process holds are swept after this many days; default 14.' },
    { key: 'NIGHTGATE_ARTIFACT_DIGEST_MAX_AGE_MS', kind: 'ms', default: 300000, min: 0, doc: 'How long the memoised current artifact digest (`getRuntimeInfo`, job resolves) may be trusted before the files are re-hashed regardless of their stat fingerprint.' },
    { key: 'NIGHTGATE_DUST_RACE_RETRIES', kind: 'int', default: 2, min: 0, doc: "Rebuild-retries of a bound deploy/call/batch on a transient dust race (`1010/170`, `1010/196`, pre-mempool, fee unspent); default `2`. Each retry re-proves the call, hence smaller than the sponsor path's `NIGHTGATE_SPONSOR_DUST_RETRIES`. `0` disables." },
    { key: 'NIGHTGATE_DUST_RACE_BACKOFF_MS', kind: 'ms', default: 5000, min: 0, doc: 'Pause before such a rebuild, letting the dust wallet apply the spend it lost against; default `5000`.' },
    { key: 'NIGHTGATE_STALE_TRANSCRIPT_RETRIES', kind: 'int', default: 2, min: 0, doc: 'Rebuild-retries of a bound deploy/call/batch the node refused against the current contract state (`1010/104`, pre-mempool, fee unspent; typically the gas budget after another transaction on the same contract grew a map); default `2`. Each retry re-runs and re-proves the call against current state.' },
    { key: 'NIGHTGATE_STALE_TRANSCRIPT_BACKOFF_MS', kind: 'ms', default: 15000, min: 0, doc: 'Pause before such a rebuild, so the indexer serves the state that includes the competing transaction; default `15000`.' },
    { key: 'NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS', kind: 'ms', default: 43200000, min: 1, doc: 'Absolute ceiling for the `connectWalletForSigning` prewarm sync-to-tip wait; default `43200000` (12 h). A backstop: the primary bound is `NIGHTGATE_PREWARM_STALL_MS`.' },
    { key: 'NIGHTGATE_PREWARM_STALL_MS', kind: 'ms', default: 600000, min: 0, worker: true, doc: 'Prewarm fails when `appliedIndex` has not advanced for this long, regardless of elapsed time; default `600000` (10 min). A slow-but-moving sync is not stalled. `0` disables the stall bound (ceiling only).' },
    { key: 'NIGHTGATE_SYNC_PROGRESS_STALE_S', kind: 'int', default: 60, min: 1, doc: '`getWalletSyncProgress` reports `stale: true` once its snapshot is older than this; default `60` (four worker push intervals).' },
    { key: 'NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS', kind: 'ms', default: 10000, min: 0, doc: 'Bounded sync gate for facade-backed read actions (`getWalletBalance`, fee estimates): a catching-up facade answers 503 `WALLET_SYNCING` after this instead of parking the request; default `10000`, `0` waits indefinitely.' },
    { key: 'NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS', kind: 'ms', default: 180000, min: 1, worker: true, doc: 'Worker-side wait for a genuine wallet sync before balancing a transaction; default `180000`.' },
    { key: 'NIGHTGATE_SYNC_TIP_GAP', kind: 'int', default: 8, min: 0, worker: true, doc: 'Blocks behind the indexer tip a wallet may be and still count as synced; default `8`.' },
    { key: 'NIGHTGATE_SYNC_FRESHNESS_MS', kind: 'ms', default: 300000, min: 1, worker: true, doc: "How old the indexer's latest block may be for a wallet to count as synced (guards against a lagging self-hosted indexer, error 117); default `300000`." },
    { key: 'NIGHTGATE_STREAM_TIP_GRACE_MS', kind: 'ms', default: 180000, min: 0, worker: true, doc: 'A failed read of the ledger-event stream tip (one-shot indexer subscription, 10 s) reuses the last successful read within this window; an unknown tip fails the sync gate for that tick. Default `180000` (three progress-watch ticks), `0` = off.' },
    { key: 'NIGHTGATE_PROGRESS_WATCH_MS', kind: 'ms', default: 60000, min: 15000, worker: true, doc: "Interval of the worker's progress watch: pushes each facade's sync-gate verdict to `getWalletSyncProgress` and `getSponsorPoolStatus` and checks restored sub-wallets for a rejected replay; default `60000`, floor 15 s." },
    { key: 'NIGHTGATE_SNAPSHOT_REPLAY_RESET_MS', kind: 'ms', default: 300000, min: 0, worker: true, doc: 'A sub-wallet restored from a snapshot that stays at its restored offset while the ledger rejects its replayed events (dust: event older than the synced time or commitment below the tree index; shielded: commitment below the tree index) is replaced by a fresh one syncing from genesis once both have lasted this long; default `300000`, `0` disables the replacement.' },
    { key: 'NIGHTGATE_DISCLOSURE_REINDEX_RETRY_MS', kind: 'ms', default: 1800000, min: 0, doc: 'When the disclosure reindex after a landed grant, revoke or retract fails, a `reindexDisclosures` job retries it with backoff for this long before failing `DISCLOSURE_REINDEX_FAILED`; default `1800000` (30 min), `0` = one attempt.' },
    { key: 'NIGHTGATE_SYNC_STATE_LOG_MS', kind: 'ms', default: 600000, min: 0, worker: true, doc: 'Interval of the per-facade INFO line `sync-state` (dust `appliedIndex` and `syncTime`, shielded `appliedIndex` and `firstFree`) written from the state save tick; default `600000`, `0` disables it.' },
    { key: 'NIGHTGATE_SAVE_INTERVAL_MS', kind: 'ms', default: 60000, min: 10000, worker: true, doc: 'Wallet-state save tick of the worker; default `60000`, floor 10 s.' },
    { key: 'NIGHTGATE_DUST_SNAPSHOT_COLLAPSE', kind: 'bool', default: false, worker: true, doc: '`true` saves the dust snapshot with foreign generation leaves collapsed (restore in seconds instead of minutes); falls back to the full snapshot when the collapsed one does not restore to the same roots, balance and UTXOs. Default `false`.' },
    { key: 'NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS', kind: 'ms', default: 30000, min: 1, worker: true, doc: 'How long a facade restore waits for the acknowledgement of its immediate re-save; default `30000`.' },
    { key: 'NIGHTGATE_DUST_COLD_START', kind: 'bool', default: false, worker: true, doc: '`true` starts the dust sub-wallet from the secret key instead of the persisted state (diagnostic).' },
    { key: 'NIGHTGATE_DUST_REGISTER_SETTLE_MS', kind: 'ms', default: 90000, min: 0, worker: true, doc: 'How long `registerForDustGeneration` waits for the registration to apply locally before it reports `settled: false`; default `90000`.' },
    { key: 'NIGHTGATE_SIGNING_KEY_RATE_LIMIT', kind: 'int', default: 10, min: 1, doc: '`connectWalletForSigning` attempts per hour per principal; default `10`.' },
    { key: 'NIGHTGATE_GRANT_ADMIN_RATE_LIMIT', kind: 'int', default: 10, min: 1, doc: 'Grant administration calls (`createAgentGrant`, `updateAgentGrant`, `rotateAgentGrantToken`, `revokeAgentGrant`) per hour per principal; default `10`.' },
    { key: 'NIGHTGATE_PUBLIC_VERIFY', kind: 'bool', default: false, doc: 'Serve `verifyAttestationState` and `verifyPredicateState` without credentials under `/api/v1/verify` (the image admits the path unauthenticated and answers CORS preflight with `*`); default off, the functions answer `404 PUBLIC_VERIFY_DISABLED`.' },
    { key: 'NIGHTGATE_PUBLIC_VERIFY_RATE_LIMIT', kind: 'int', default: 60, min: 1, doc: 'Public verify calls per minute per client address; default `60`.' },
    { key: 'NIGHTGATE_CLAIM_LIFETIME_S', kind: 'int', default: 31536000, min: 60, doc: 'Default claim lifetime in seconds for the issue* actions when the caller passes no `validUntil`; default one year, the vault caps a claim at five years ahead.' },
    { key: 'NIGHTGATE_FEE_SPONSOR_SESSION', kind: 'list', doc: 'Comma list of platform fee-sponsor session ids (the pool); overrides `feeSponsorSessions`.' },
    { key: 'NIGHTGATE_SUBMIT_TRANSPORT_RETRIES', kind: 'int', default: 2, min: 0, worker: true, doc: 'Resends of the SAME finalized transaction when nothing reached the node (connect phase failed) or the send itself died (websocket closed mid-send, `ECONNRESET`; the indexer is probed for the identifier first); never a node reject, never a reply-less wait. Default `2`, `0` disables. No rebuild, no re-proving. Applies to every submit: deploy/call/batch, sends, dust registration, bound and unbound sponsoring.' },
    { key: 'NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS', kind: 'ms', default: 5000, min: 0, worker: true, doc: 'Pause before such a resend; default `5000`.' },
    { key: 'NIGHTGATE_SUBMIT_LANDED_PROBE_MS', kind: 'ms', default: 30000, min: 0, worker: true, doc: 'How long the worker polls the indexer for the transaction identifier before a resend, and after a resend was rejected (a reply lost on the first send may still have reached the node); default `30000`. A landed transaction is reported as submitted only with ledger result `SUCCESS`; in a block but not applied fails as `TxFailedError` with the block height (fee spent).' },
    { key: 'NIGHTGATE_SUBMIT_INTENT_ACK_TIMEOUT_MS', kind: 'ms', default: 120000, min: 1000, worker: true, doc: 'How long the worker waits for the main thread to record an announced transaction identifier before it gives up without broadcasting; default 2 minutes. Keep it above the database pool acquire timeout plus the lock-contention retries.' },
    { key: 'NIGHTGATE_SUBMIT_CONNECT_TIMEOUT_MS', kind: 'ms', default: 20000, min: 1, worker: true, doc: 'Connect phase of a dedicated-client submit: client creation plus socket; default `20000`. A timeout here sent nothing (`transport/not-sent`, retried once on a fresh client, then a clean pre-inclusion failure).' },
    { key: 'NIGHTGATE_SUBMIT_REQUEST_TIMEOUT_MS', kind: 'ms', default: 30000, min: 1, worker: true, doc: "Request phase of a dedicated-client submit: from the send until the node's first status (subscription acknowledged); default `30000`. A timeout here is ambiguous (`no-reply`): the transaction may or may not be in the pool, the job parks for the confirmer." },
    { key: 'NIGHTGATE_SUBMIT_LATE_GRACE_MS', kind: 'ms', default: 300000, min: 0, worker: true, doc: 'After a request or watch phase timeout the attempt keeps its node subscription open this long and logs a late status or reject under the transaction identifier (evidence only; the job is parked for the confirmer either way); default `300000`.' },
    { key: 'NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS', kind: 'ms', default: 75000, min: 1, worker: true, doc: "Watch phase of a submit: from the node's first status until InBlock (or Finalized, `NIGHTGATE_SPONSOR_WAIT`); default `75000`. A timeout here is ambiguous: the node took the request and nothing was included in time; the indexer is asked for 90 s, then the job parks for the confirmer. On the facade (bound) path this is the whole wait after the send." },
    { key: 'NIGHTGATE_BROADCAST_EXPIRY_MARGIN_MS', kind: 'ms', default: 300000, min: 0, doc: 'A job parked in `reconciliation_required` whose transaction the indexer does not know ends `failed / BROADCAST_NOT_INCLUDED` once the indexer tip is this far past the transaction\'s validity window (ttl); default `300000`. The ttl is recorded at the submit intent; rows without one use the submit time plus one hour.' },
    { key: 'NIGHTGATE_BATCH_SEGMENT_MODE', kind: 'enum', default: 'rewrite', values: ['rewrite', 'observe'], worker: true, doc: 'Batch segment ordering: `rewrite` (deterministic stage-grouped order) or `observe` (log only).' },
    { key: 'NIGHTGATE_SPONSOR_POLICY_FILE', kind: 'path', doc: 'Path to a JSON file `{ "allowedContracts": [], "allowedCircuits": [], "allowDeploy": false, "allowedTokenTypes": [] }` that replaces `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`/`_CIRCUITS` while set. Calls on a grant\'s `deployedContracts` are exempt from `allowedCircuits`. Re-read per sponsored call behind an mtime cache, so the sponsor policy changes without a container recreate. Fail-closed: an unreadable or invalid file keeps the last good policy, and with none loaded yet sponsored calls answer `503 SPONSOR_POLICY_UNAVAILABLE`.' },
    { key: 'NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', kind: 'list', doc: 'Comma list of contract addresses a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set.' },
    { key: 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS', kind: 'list', doc: 'Comma list of circuit names a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set.' },
    { key: 'NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES', kind: 'list', doc: 'Comma list of raw shielded token types (64 hex, what `deriveTokenType` returns) whose zswap offers the sponsor also pays for: a contract minting its own token to the caller, a caller spending that token into the contract. Unset = no offer at all (the default). Also `allowedTokenTypes` in the policy file and on a grant (effective = floor ∩ grant; the floor must open it, a grant only narrows). The shape check then requires every net change of the offer (`deltas`, public per type) to be on a listed type, never NIGHT, every contract-owned coin to belong to a sponsorable contract, and a net change to exist OR a coin in the offer to be owned by a sponsorable contract (a burn nets to zero by construction: user input, contract transient, burn-address output; a zero-net offer without a contract coin is refused). User outputs are commitments, so a transfer of a listed type between users riding along is accepted by design: the sponsor pays dust, no sponsor value moves. An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`).' },
    { key: 'NIGHTGATE_SPONSOR_ALLOW_DEPLOY', kind: 'bool', default: false, doc: 'Opens sponsored contract DEPLOYS on this deployment: `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowDeploy` on its grant with deploy budget left; a plain caller inherits the floor. Also settable as `allowDeploy` in `NIGHTGATE_SPONSOR_POLICY_FILE`.' },
    { key: 'NIGHTGATE_SPONSOR_MAX_TX_BYTES', kind: 'int', default: 65536, min: 1, worker: true, doc: 'Byte ceiling of a sponsored call transaction the worker accepts; default `65536`.' },
    { key: 'NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES', kind: 'int', default: 40960, min: 1, worker: true, doc: 'Byte ceiling of a sponsored DEPLOY transaction (a deploy writes verifier keys on chain and costs a multiple of a call); default `40960`.' },
    { key: 'NIGHTGATE_SPONSOR_WAIT', kind: 'enum', default: 'inblock', values: ['inblock', 'finalized'], worker: true, doc: 'Submission stage every submit waits for on its dedicated node client: `inblock` (default) or `finalized`. The indexer confirmer records the final inclusion on the job either way.' },
    { key: 'NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS', kind: 'ms', default: 30000, min: 0, worker: true, doc: 'After the awaited status (InBlock or Finalized), bounded wait until the public indexer shows the transaction and check its ledger result there (in a block but not applied fails as `TxFailedError`); `0` skips the wait and the check, the indexer confirmer still records the outcome on the job; default `30000`.' },
    { key: 'NIGHTGATE_SPONSORED_CALLER_SYNC', kind: 'enum', default: 'wait', values: ['wait', 'skip'], worker: true, doc: '`skip` omits the caller-side wallet sync when balancing a sponsored transaction (vault calls move no caller value).' },
    { key: 'NIGHTGATE_NOTE_LEASE_MS', kind: 'ms', default: 300000, min: 1, worker: true, doc: 'Lease on a dust note backing a sponsored transaction (parallel sponsoring from one wallet); a non-positive or non-numeric value falls back to the default `300000`.' },
    { key: 'NIGHTGATE_BACKING_WAIT_MS', kind: 'ms', default: 300000, min: 0, worker: true, doc: 'How long an unbound sponsoring waits for a free dust backing before it refuses; default `300000`.' },
    { key: 'NIGHTGATE_SPONSOR_PREWARM_SYNC_MS', kind: 'ms', default: 1800000, min: 0, doc: 'Prewarm brings pool members to the chain tip one at a time; this caps the wait per sponsor, default 30 min, `0` = build only.' },
    { key: 'NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS', kind: 'ms', default: 45000, min: 1, doc: 'Per-sponsor read cap of `getSponsorPoolStatus`; default `45000`.' },
    { key: 'NIGHTGATE_SPONSOR_LEASE_WAIT_MS', kind: 'ms', default: 120000, min: 0, doc: 'How long a sponsored job waits for a busy or cooling sponsor before it fails over or gives up; default `120000`.' },
    { key: 'NIGHTGATE_SPONSOR_COOLDOWN_MS', kind: 'ms', default: 120000, min: 0, doc: 'Bench time of a sponsor after a retryable failure; default `120000`.' },
    { key: 'NIGHTGATE_SPONSOR_DUST_RETRIES', kind: 'int', default: 4, min: 0, doc: 'Rebuild-retries of a sponsored transaction on a dust race, on the same sponsor; default `4`.' },
    { key: 'NIGHTGATE_SPONSOR_DUST_BACKOFF_MS', kind: 'ms', default: 5000, min: 0, doc: 'Pause before such a rebuild; default `5000`.' },
    { key: 'ENCRYPTION_KEY', kind: 'secret', doc: 'At-rest secret (32+ byte hex) for viewing keys, seed keys and encrypted job commands; key id `1` of the ring. Without any key a random per-process dev key is used (rows do not survive a restart); **required** in production. Env only, no CAP mapping.' },
    { key: 'ENCRYPTION_KEYS', kind: 'secret', doc: 'Key ring `id=secret,id=secret` (ids `[A-Za-z0-9_-]{1,16}`); `ENCRYPTION_KEY` joins it as id `1`. Every secret is HKDF-stretched; ciphertexts are `v2:<keyId>:...` envelopes (per-row data key wrapped by the ring key, key id bound as AAD). Legacy `iv:tag:data` values stay readable under id `1`. Env only, no CAP mapping.' },
    { key: 'ENCRYPTION_KEY_ACTIVE', kind: 'string', doc: 'Id of the ring key new ciphertexts are written under (required with more than one key). Startup refuses a database whose ciphertexts name a key id outside the ring; `nightgate-rewrap-keys` moves rows to the active key (see docs/operations.md, key rotation). Env only, no CAP mapping.' }
];

const BY_KEY: ReadonlyMap<string, ConfigSpec> = new Map(CONFIG_TABLE.map(s => [s.key, s]));

export function configSpec(key: string): ConfigSpec {
    const spec = BY_KEY.get(key);
    if (!spec) throw new Error(`config: '${key}' is not declared in CONFIG_TABLE`);
    return spec;
}

export function isConfigKey(key: string): boolean {
    return BY_KEY.has(key);
}

/** Keys that never come from a CAP host's `cds.requires.nightgate` block. */
export function isEnvOnlyKey(key: string): boolean {
    return key.startsWith('ENCRYPTION_');
}

export interface ParsedConfigValue {
    value: ConfigValue;
    /** Set when the raw value was rejected or clamped; the caller logs it once. */
    warning?: string;
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'on']);
const FALSE_WORDS = new Set(['false', '0', 'no', 'off']);

/** Parse an env string or CAP value under its spec; undefined, null and '' mean unset. */
export function parseConfigValue(spec: ConfigSpec, raw: unknown): ParsedConfigValue {
    if (raw === undefined || raw === null) return { value: spec.default };
    if (typeof raw === 'string' && raw.trim() === '') return { value: spec.default };
    const text = typeof raw === 'string' ? raw.trim() : raw;
    const fallback = (why: string): ParsedConfigValue => ({
        value: spec.default,
        warning: `${spec.key}: ${why}; using ${spec.default === undefined ? 'no value' : `the default ${JSON.stringify(spec.default)}`}`
    });
    switch (spec.kind) {
        case 'int':
        case 'ms': {
            const n = typeof text === 'number' ? text : (typeof text === 'string' && /^[+-]?\d+$/.test(text) ? Number(text) : NaN);
            if (!Number.isInteger(n)) return fallback(`'${String(raw)}' is not an integer`);
            const v = n;
            // Below min is invalid (default applies); above max is clamped.
            if (spec.min !== undefined && v < spec.min) return fallback(`${v} is below the minimum ${spec.min}`);
            if (spec.max !== undefined && v > spec.max) {
                return { value: spec.max, warning: `${spec.key}: ${v} is above the maximum ${spec.max}; clamped to ${spec.max}` };
            }
            return { value: v };
        }
        case 'bool': {
            if (typeof text === 'boolean') return { value: text };
            const word = String(text).toLowerCase();
            if (TRUE_WORDS.has(word)) return { value: true };
            if (FALSE_WORDS.has(word)) return { value: false };
            return fallback(`'${String(raw)}' is not a boolean (true/false/1/0/yes/no/on/off)`);
        }
        case 'enum': {
            const word = String(text).toLowerCase();
            const hit = (spec.values ?? []).find(v => v.toLowerCase() === word);
            if (hit === undefined) return fallback(`'${String(raw)}' is not one of ${(spec.values ?? []).join(' | ')}`);
            return { value: hit };
        }
        case 'list': {
            if (Array.isArray(text)) return { value: text.map(v => String(v).trim()).filter(Boolean) };
            return { value: String(text).split(',').map(s => s.trim()).filter(Boolean) };
        }
        case 'url':
        case 'path':
        case 'string':
        case 'secret':
            return { value: String(text) };
        default:
            return { value: String(text) };
    }
}

/** Resolve every key (env, CAP block, default) with the parse warnings. */
export function resolveConfigTable(
    env: Record<string, string | undefined>,
    overrides?: Record<string, unknown> | null
): { values: Record<string, ConfigValue>; warnings: string[] } {
    const values: Record<string, ConfigValue> = {};
    const warnings: string[] = [];
    for (const spec of CONFIG_TABLE) {
        const { value, warning } = resolveOne(spec, env, overrides);
        values[spec.key] = value;
        if (warning) warnings.push(warning);
    }
    return { values, warnings };
}

export function resolveOne(
    spec: ConfigSpec,
    env: Record<string, string | undefined>,
    overrides?: Record<string, unknown> | null
): ParsedConfigValue {
    const fromEnv = env[spec.key];
    if (fromEnv !== undefined && fromEnv.trim() !== '') return parseConfigValue(spec, fromEnv);
    if (overrides && !isEnvOnlyKey(spec.key)) {
        const fromCap = overrides[camelConfigKey(spec.key)];
        if (fromCap !== undefined && fromCap !== null && fromCap !== '') return parseConfigValue(spec, fromCap);
    }
    return { value: spec.default };
}

/** One markdown row per key, the block `docs/reference.md` carries verbatim. */
export function configTableMarkdownRows(): string[] {
    const fmtDefault = (spec: ConfigSpec): string => {
        if (spec.default === undefined) return '';
        return '`' + String(spec.default) + '`';
    };
    const fmtKind = (spec: ConfigSpec): string => {
        if (spec.kind === 'enum') return (spec.values ?? []).map(v => '`' + v + '`').join(' / ');
        const bounds = spec.min !== undefined || spec.max !== undefined
            ? ` (${spec.min !== undefined ? `min ${spec.min}` : ''}${spec.min !== undefined && spec.max !== undefined ? ', ' : ''}${spec.max !== undefined ? `max ${spec.max}` : ''})`
            : '';
        return spec.kind + bounds;
    };
    return CONFIG_TABLE.map(spec =>
        `| \`${spec.key}\` | ${fmtKind(spec)} | ${fmtDefault(spec)} | ${spec.doc}${spec.worker ? ' Read in the wallet worker.' : ''} |`);
}
