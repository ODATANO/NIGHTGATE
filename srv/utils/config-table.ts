/**
 * The one table of NIGHTGATE's environment knobs, with typed parsing.
 *
 * Every `NIGHTGATE_*` variable the plugin reads is declared here with its
 * kind, default and bounds; the accessors in `config.ts` read through this
 * table. The rules, applied to every key alike:
 *   - empty string = unset (the default applies; `Number('')` is never 0),
 *   - a value that does not parse = a warning once and the default (never
 *     `NaN`, so a mistyped timeout cannot fire immediately),
 *   - a value below `min` is invalid (warning, default), above `max` is clamped,
 *   - booleans accept true/false/1/0/yes/no/on/off,
 *   - a CAP host may set any key as `cds.requires.nightgate.<camelCase>`
 *     (`NIGHTGATE_WORKER_RPC_TIMEOUT_MS` -> `workerRpcTimeoutMs`); the env
 *     variable wins over the CAP value, the CAP value over the default.
 *
 * No cds import: the wallet worker loads this module too and receives the
 * resolved values from the main thread (`workerData`), never from its env.
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
    { key: 'NIGHTGATE_PROOF_TIMEOUT_MS', kind: 'ms', default: 300000, min: 1, worker: true, doc: 'Override `proofTimeoutMs` (0.22.0); pinned into the env at plugin init for the wallet worker. The proof-server container has its own job TTL (`MIDNIGHT_PROOF_SERVER_JOB_TIMEOUT`, default 600 s): raise both, or a finished-but-expired job answers 5xx and midnight-js re-proves.' },
    { key: 'NIGHTGATE_ZK_CONFIG_BASE', kind: 'path', default: './contracts', doc: 'Override `zkConfigBasePath`' },
    { key: 'NIGHTGATE_ZK_CONFIG_PUBLIC_URL', kind: 'url', doc: 'Public base URL advertised by `/contract-manifest` for the `/zk-config/...` routes (behind a reverse proxy); unset = relative URLs, resolved by the client against the origin it fetched the manifest from' },
    { key: 'NIGHTGATE_ZK_ASSET_URL', kind: 'string', doc: 'A `/zk-config` base the server fetches missing prover keys from (`<url>/<contract>/keys/<circuit>.prover`, verified against `keys/manifest.json`); `none`/`off` disables the fetch. Unset: the release tag on raw.githubusercontent.com for the shipped contracts, no source for others. Offline installs run `nightgate-fetch-keys` once.' },
    { key: 'NIGHTGATE_CONTRACTS_DIR', kind: 'string', doc: "Root directories (path-delimiter separated) a runtime `registerContract` (admin, 0.21.0) may point into; default: the package's and the working directory's `contracts/`. Importing an artifact executes its module, so paths outside are refused. The supported way to keep a consumer's artifacts outside the package: point it at that directory. The artifact's `@midnight-ntwrk/compact-runtime` import resolves from NIGHTGATE's own node_modules (worker snapshots since 0.21.0, the registration probe since 0.22.0), so the directory needs no node_modules of its own." },
    { key: 'NIGHTGATE_PRIVATE_STATE_BACKEND', kind: 'enum', values: ['cap-db', 'level'], doc: 'Override `privateStateBackend`' },
    { key: 'NIGHTGATE_GRANTEE_BINDING', kind: 'enum', values: ['wallet', 'did', 'custom'], doc: 'Override `granteeBinding` (`wallet` / `did` / `custom`)' },
    { key: 'NIGHTGATE_ALLOW_SELF_SERVICE_GRANTEE_REGISTRATION', kind: 'bool', doc: 'Override `allowSelfServiceGranteeRegistration` (`false` / `0` / `no` / `off` disables)' },
    { key: 'NIGHTGATE_CLOSE_SESSIONS_ON_RESTART', kind: 'bool', doc: 'Override `closeSessionsOnRestart` (default on): `false` keeps the previous process\'s wallet sessions open across a restart' },
    { key: 'NIGHTGATE_INSTANCE_ID', kind: 'string', doc: 'Stable operator-provided instance identifier; otherwise CF instance GUID, hostname, or a generated UUID' },
    { key: 'NIGHTGATE_REPLICA_COUNT', kind: 'int', min: 1, doc: 'Actual process/replica count. Must be `1`; takes precedence over CDS `replicaCount`' },
    { key: 'NIGHTGATE_ALLOW_PRODUCTION_SQLITE', kind: 'bool', default: false, doc: '`true` temporarily permits production SQLite with a high-severity warning; intended only for a migration window' },
    { key: 'NIGHTGATE_ASSUME_DB_NETWORK', kind: 'string', doc: 'Confirms which network an index written before 0.16.2 (rows without a recorded network id) belongs to; the boot guard refuses to bind such an index to the configured network otherwise.' },
    { key: 'NIGHTGATE_STATUS_ROUTES', kind: 'enum', values: ['off', 'public'], doc: 'Plain `/nightgate/metrics|health|ready` routes: unset = mounted only with `NIGHTGATE_STATUS_TOKEN`, `public` = mounted without a token, `off` = not mounted.' },
    { key: 'NIGHTGATE_STATUS_ROUTES_PREFIX', kind: 'path', default: '/nightgate', doc: 'Path prefix of the plain status routes.' },
    { key: 'NIGHTGATE_STATUS_TOKEN', kind: 'secret', doc: 'Bearer token the plain status routes require; without it (and without `NIGHTGATE_STATUS_ROUTES=public`) they are not mounted.' },
    { key: 'NIGHTGATE_DEBUG_WALLET_SYNC', kind: 'bool', default: false, doc: '`true` logs wallet sync-state persistence at debug level' },
    { key: 'NIGHTGATE_CRAWLER_ENABLED', kind: 'bool', doc: '`false` / `0` / `no` / `off` disables the crawler at boot' },
    { key: 'NIGHTGATE_FETCH_CONCURRENCY', kind: 'int', min: 1, doc: 'Override `crawler.fetchConcurrency`' },
    { key: 'NIGHTGATE_RPC_BATCH_SIZE', kind: 'int', min: 1, doc: 'Override `crawler.rpcBatchSize`' },
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
    { key: 'NIGHTGATE_PREWARM_SYNC_TIMEOUT_MS', kind: 'ms', default: 43200000, min: 1, doc: 'Absolute ceiling for the `connectWalletForSigning` prewarm sync-to-tip wait; default `43200000` (12 h, 0.21.0; was 3 h). A backstop: the primary bound is `NIGHTGATE_PREWARM_STALL_MS`.' },
    { key: 'NIGHTGATE_PREWARM_STALL_MS', kind: 'ms', default: 600000, min: 0, worker: true, doc: 'Prewarm fails when `appliedIndex` has not advanced for this long, regardless of elapsed time; default `600000` (10 min). A slow-but-moving sync is not stalled. `0` disables the stall bound (ceiling only).' },
    { key: 'NIGHTGATE_SYNC_PROGRESS_STALE_S', kind: 'int', default: 60, min: 1, doc: '`getWalletSyncProgress` reports `stale: true` once its snapshot is older than this; default `60` (four worker push intervals).' },
    { key: 'NIGHTGATE_WALLET_READ_SYNC_TIMEOUT_MS', kind: 'ms', default: 10000, min: 0, doc: 'Bounded sync gate for facade-backed read actions (`getWalletBalance`, fee estimates): a catching-up facade answers 503 `WALLET_SYNCING` after this instead of parking the request; default `10000`, `0` waits indefinitely.' },
    { key: 'NIGHTGATE_BALANCE_SYNC_TIMEOUT_MS', kind: 'ms', default: 180000, min: 1, worker: true, doc: 'Worker-side wait for a genuine wallet sync before balancing a transaction; default `180000`.' },
    { key: 'NIGHTGATE_SYNC_TIP_GAP', kind: 'int', default: 8, min: 0, worker: true, doc: 'Blocks behind the indexer tip a wallet may be and still count as synced; default `8`.' },
    { key: 'NIGHTGATE_SYNC_FRESHNESS_MS', kind: 'ms', default: 300000, min: 1, worker: true, doc: "How old the indexer's latest block may be for a wallet to count as synced (guards against a lagging self-hosted indexer, error 117); default `300000`." },
    { key: 'NIGHTGATE_PROGRESS_WATCH_MS', kind: 'ms', default: 60000, min: 15000, worker: true, doc: "Interval of the worker's idle progress watch that keeps `getWalletSyncProgress` fresh while a facade is behind; default `60000`, floor 15 s." },
    { key: 'NIGHTGATE_SAVE_INTERVAL_MS', kind: 'ms', default: 60000, min: 10000, worker: true, doc: 'Wallet-state save tick of the worker; default `60000` (0.21.6, was 30 s), floor 10 s.' },
    { key: 'NIGHTGATE_RESTORE_SAVE_ACK_TIMEOUT_MS', kind: 'ms', default: 30000, min: 1, worker: true, doc: 'How long a facade restore waits for the acknowledgement of its immediate re-save; default `30000`.' },
    { key: 'NIGHTGATE_DUST_COLD_START', kind: 'bool', default: false, worker: true, doc: '`true` starts the dust sub-wallet from the secret key instead of the persisted state (diagnostic).' },
    { key: 'NIGHTGATE_DUST_REGISTER_SETTLE_MS', kind: 'ms', default: 90000, min: 0, worker: true, doc: 'How long `registerForDustGeneration` waits for the registration to apply locally before it reports `settled: false`; default `90000`.' },
    { key: 'NIGHTGATE_SIGNING_KEY_RATE_LIMIT', kind: 'int', default: 10, min: 1, doc: '`connectWalletForSigning` attempts per hour per principal; default `10`.' },
    { key: 'NIGHTGATE_FEE_SPONSOR_SESSION', kind: 'list', doc: 'Comma list of platform fee-sponsor session ids (the pool); overrides `feeSponsorSessions`.' },
    { key: 'NIGHTGATE_SUBMIT_TRANSPORT_RETRIES', kind: 'int', default: 2, min: 0, worker: true, doc: 'Resends of the SAME finalized transaction when the send itself fails (websocket closed at submit, `1000 Normal Closure`, `ECONNRESET`; never a node reject, never a reply-less wait), 0.22.0; default `2`, `0` disables. No rebuild, no re-proving: the facade re-pends the spends and the identical bytes go out again. Applies to every bound submit (deploy/call/batch, sends, dust registration, bound sponsoring).' },
    { key: 'NIGHTGATE_SUBMIT_TRANSPORT_BACKOFF_MS', kind: 'ms', default: 5000, min: 0, worker: true, doc: 'Pause before such a resend; default `5000`.' },
    { key: 'NIGHTGATE_SUBMIT_LANDED_PROBE_MS', kind: 'ms', default: 30000, min: 0, worker: true, doc: 'How long the worker polls the indexer for the transaction identifier before a resend, and after a resend was rejected (a reply lost on the first send may still have reached the node); default `30000`. A landed transaction is reported as submitted only with ledger result `SUCCESS`; in a block but not applied fails as `TxFailed` (fee spent).' },
    { key: 'NIGHTGATE_SUBMIT_WATCH_TIMEOUT_MS', kind: 'ms', default: 60000, min: 1, worker: true, doc: "How long a bound submit waits for the node's first status after the send before the outcome counts as ambiguous (reconciled by identifier, never resent); default `60000`." },
    { key: 'NIGHTGATE_BATCH_SEGMENT_MODE', kind: 'enum', default: 'rewrite', values: ['rewrite', 'observe'], worker: true, doc: 'Batch segment ordering: `rewrite` (deterministic stage-grouped order) or `observe` (log only).' },
    { key: 'NIGHTGATE_SPONSOR_POLICY_FILE', kind: 'path', doc: 'Path to a JSON file `{ "allowedContracts": [], "allowedCircuits": [], "allowDeploy": false, "allowedTokenTypes": [] }` that replaces `NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS`/`_CIRCUITS` while set (0.21.0). Calls on a grant\'s `deployedContracts` are exempt from `allowedCircuits` (0.21.2). Re-read per sponsored call behind an mtime cache, so the sponsor policy changes without a container recreate. Fail-closed: an unreadable or invalid file keeps the last good policy, and with none loaded yet sponsored calls answer `503 SPONSOR_POLICY_UNAVAILABLE`.' },
    { key: 'NIGHTGATE_SPONSOR_ALLOWED_CONTRACTS', kind: 'list', doc: 'Comma list of contract addresses a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set.' },
    { key: 'NIGHTGATE_SPONSOR_ALLOWED_CIRCUITS', kind: 'list', doc: 'Comma list of circuit names a sponsor pays for (platform floor); empty = any. Replaced by `NIGHTGATE_SPONSOR_POLICY_FILE` while that is set.' },
    { key: 'NIGHTGATE_SPONSOR_ALLOWED_TOKEN_TYPES', kind: 'list', doc: 'Comma list of raw shielded token types (64 hex, what `deriveTokenType` returns) whose zswap offers the sponsor also pays for (0.22.0): a contract minting its own token to the caller, a caller spending that token into the contract. Unset = no offer at all (the default, unchanged). Also `allowedTokenTypes` in the policy file and on a grant (effective = floor ∩ grant; the floor must open it, a grant only narrows). The shape check then requires every net change of the offer (`deltas`, public per type) to be on a listed type, never NIGHT, every contract-owned coin to belong to a sponsorable contract, and a net change to exist OR a coin in the offer to be owned by a sponsorable contract (a burn nets to zero by construction: user input, contract transient, burn-address output; a zero-net offer without a contract coin is refused). User outputs are commitments, so a transfer of a listed type between users riding along is accepted by design: the sponsor pays dust, no sponsor value moves. An invalid entry fails closed (`503 SPONSOR_POLICY_UNAVAILABLE`).' },
    { key: 'NIGHTGATE_SPONSOR_ALLOW_DEPLOY', kind: 'bool', default: false, doc: 'Opens sponsored contract DEPLOYS on this deployment (0.21.0): `true`/`1`/`yes`. Off by default. A token caller additionally needs `allowDeploy` on its grant with deploy budget left; a plain caller inherits the floor. Also settable as `allowDeploy` in `NIGHTGATE_SPONSOR_POLICY_FILE`.' },
    { key: 'NIGHTGATE_SPONSOR_MAX_TX_BYTES', kind: 'int', default: 65536, min: 1, worker: true, doc: 'Byte ceiling of a sponsored call transaction the worker accepts; default `65536`.' },
    { key: 'NIGHTGATE_SPONSOR_MAX_DEPLOY_BYTES', kind: 'int', default: 40960, min: 1, worker: true, doc: 'Byte ceiling of a sponsored DEPLOY transaction (a deploy writes verifier keys on chain and costs a multiple of a call); default `40960`.' },
    { key: 'NIGHTGATE_SPONSOR_WAIT', kind: 'enum', default: 'inblock', values: ['inblock', 'finalized'], worker: true, doc: 'Submission stage the unbound sponsor path waits for: `inblock` (default) or `finalized`.' },
    { key: 'NIGHTGATE_SPONSOR_INDEXER_VISIBLE_MS', kind: 'ms', default: 30000, min: 0, worker: true, doc: 'After InBlock, bounded wait until the public indexer shows the sponsored transaction; `0` skips the wait; default `30000`.' },
    { key: 'NIGHTGATE_SPONSORED_CALLER_SYNC', kind: 'enum', default: 'wait', values: ['wait', 'skip'], worker: true, doc: '`skip` omits the caller-side wallet sync when balancing a sponsored transaction (vault calls move no caller value).' },
    { key: 'NIGHTGATE_NOTE_LEASE_MS', kind: 'ms', default: 300000, min: 1, worker: true, doc: 'Lease on a dust note backing a sponsored transaction (parallel sponsoring from one wallet); a non-positive or non-numeric value falls back to the default `300000`.' },
    { key: 'NIGHTGATE_BACKING_WAIT_MS', kind: 'ms', default: 300000, min: 0, worker: true, doc: 'How long an unbound sponsoring waits for a free dust backing before it refuses; default `300000`.' },
    { key: 'NIGHTGATE_SPONSOR_PREWARM_SYNC_MS', kind: 'ms', default: 1800000, min: 0, doc: 'Prewarm brings pool members to the chain tip one at a time (0.21.4); this caps the wait per sponsor, default 30 min, `0` = build only.' },
    { key: 'NIGHTGATE_SPONSOR_STATUS_TIMEOUT_MS', kind: 'ms', default: 45000, min: 1, doc: 'Per-sponsor read cap of `getSponsorPoolStatus`; default `45000`.' },
    { key: 'NIGHTGATE_SPONSOR_LEASE_WAIT_MS', kind: 'ms', default: 120000, min: 0, doc: 'How long a sponsored job waits for a busy or cooling sponsor before it fails over or gives up; default `120000`.' },
    { key: 'NIGHTGATE_SPONSOR_COOLDOWN_MS', kind: 'ms', default: 120000, min: 0, doc: 'Bench time of a sponsor after a retryable failure; default `120000`.' },
    { key: 'NIGHTGATE_SPONSOR_DUST_RETRIES', kind: 'int', default: 4, min: 0, doc: 'Rebuild-retries of a sponsored transaction on a dust race, on the same sponsor; default `4`.' },
    { key: 'NIGHTGATE_SPONSOR_DUST_BACKOFF_MS', kind: 'ms', default: 5000, min: 0, doc: 'Pause before such a rebuild; default `5000`.' },
    { key: 'ENCRYPTION_KEY', kind: 'secret', doc: 'At-rest secret (32+ byte hex) for viewing keys, seed keys and encrypted job commands; key id `1` of the ring. Without any key a random per-process dev key is used (rows do not survive a restart); **required** in production. Env only, no CAP mapping.' },
    { key: 'ENCRYPTION_KEYS', kind: 'secret', doc: 'Key ring `id=secret,id=secret` (ids `[A-Za-z0-9_-]{1,16}`); `ENCRYPTION_KEY` joins it as id `1`. Every secret is HKDF-stretched; ciphertexts are `v2:<keyId>:...` envelopes (per-row data key wrapped by the ring key, key id bound as AAD). Pre-0.23 `iv:tag:data` values stay readable under id `1`. Env only, no CAP mapping.' },
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

/**
 * Parse one raw value under its spec. `raw` may be an env string or a CAP
 * config value (number, boolean, string, array); `undefined`, `null` and the
 * empty string mean unset.
 */
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
            // Below the minimum is not a small value but an invalid one (a
            // negative duration, a zero where zero means "off" is not
            // offered): the default applies. Above the maximum is clamped.
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

/**
 * Resolve every key: env first, then the CAP block (`camelCase`), then the
 * default. Returns the values and the warnings the parse produced.
 */
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
