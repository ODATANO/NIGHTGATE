/**
 * CAP-DB-backed private-state provider for the Midnight JS SDK.
 *
 * Replaces `@midnight-ntwrk/midnight-js-level-private-state-provider` for
 * production use. The SDK's LevelDB provider has an explicit JSDoc warning
 * against production use ("clearing local files permanently destroys the
 * private state", no recovery path). This implementation persists into
 * NIGHTGATE's CAP DB (SQLite dev / HANA prod) with the same AES-256-GCM
 * encryption format the SDK uses for its export blobs.
 *
 * Wire-format compatibility: an export produced here is importable by the
 * SDK's LevelDB provider and vice versa. See srv/utils/storage-encryption.ts.
 *
 * Scope: instance is bound to a single `accountId` (a wallet identifier such
 * as the wallet address). All set/get/remove operations are also scoped to
 * the `currentContractAddress` set via `setContractAddress()` per the SDK
 * interface contract.
 */

import crypto from 'crypto';
import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
import {
    StorageEncryption,
    decryptWithPassword,
    SALT_LENGTH
} from '../utils/storage-encryption';
import { ensureNightgateModelLoaded } from '../utils/cds-model';

const MAX_EXPORT_STATES       = 10_000;
const MAX_EXPORT_SIGNING_KEYS = 10_000;
const PRIVATE_STATE_EXPORT_FORMAT = 'midnight-private-state-export';
const SIGNING_KEY_EXPORT_FORMAT   = 'midnight-signing-key-export';
const CURRENT_EXPORT_VERSION  = 1;
const SUPPORTED_EXPORT_VERSIONS = [1];

// ---- Interface mirror types (decoupled from SDK imports, SDK is ESM-only) -
// We model the structural shape we implement; the SDK is duck-typed so it
// accepts an object that matches PrivateStateProvider<PSI, PS>.

type ContractAddress = string;
type PrivateStateId  = string;
type SigningKey      = string;

interface PrivateStateExport {
    readonly format: 'midnight-private-state-export';
    readonly encryptedPayload: string;
    readonly salt: string;          // hex 32 bytes
}

interface SigningKeyExport {
    readonly format: 'midnight-signing-key-export';
    readonly encryptedPayload: string;
    readonly salt: string;
}

interface ExportPrivateStatesOptions {
    readonly password?: string;
    readonly maxStates?: number;
}

interface ImportPrivateStatesOptions {
    readonly password?: string;
    readonly conflictStrategy?: 'skip' | 'overwrite' | 'error';
    readonly maxStates?: number;
}

interface ImportPrivateStatesResult {
    readonly imported: number;
    readonly skipped: number;
    readonly overwritten: number;
}

interface ExportSigningKeysOptions {
    readonly password?: string;
    readonly maxKeys?: number;
}

interface ImportSigningKeysOptions {
    readonly password?: string;
    readonly conflictStrategy?: 'skip' | 'overwrite' | 'error';
    readonly maxKeys?: number;
}

interface ImportSigningKeysResult {
    readonly imported: number;
    readonly skipped: number;
    readonly overwritten: number;
}

// ---- Errors (names match SDK convention) -----------------------------------

export class ExportDecryptionError extends Error {
    constructor() { super('Failed to decrypt export'); this.name = 'ExportDecryptionError'; }
}
export class InvalidExportFormatError extends Error {
    constructor(msg: string) { super(msg); this.name = 'InvalidExportFormatError'; }
}
export class ImportConflictError extends Error {
    constructor(conflictCount: number) {
        super(`Import aborted: ${conflictCount} conflict(s) detected and conflictStrategy is 'error'`);
        this.name = 'ImportConflictError';
    }
}

// ---- Config -----------------------------------------------------------------

export interface CapDbPrivateStateProviderConfig {
    accountId: string;
    privateStoragePasswordProvider: () => Promise<string> | string;
    /**
     * Optional db handle. Defaults to `cds.connect.to('db')` on first use.
     * Injecting a handle is useful for tests.
     */
    db?: any;
}

// ---- Provider ---------------------------------------------------------------

export class CapDbPrivateStateProvider<PSI extends PrivateStateId = PrivateStateId, PS = any> {
    private currentContractAddress: ContractAddress | null = null;
    private db: cds.DatabaseService | undefined;
    private encryptionPromise: Promise<StorageEncryption> | undefined;

    constructor(private readonly config: CapDbPrivateStateProviderConfig) {
        if (!config.accountId)                     throw new Error('accountId is required');
        if (!config.privateStoragePasswordProvider) throw new Error('privateStoragePasswordProvider is required');
        if (config.db) this.db = config.db;
    }

    // -- Interface implementation --------------------------------------------

    setContractAddress(address: ContractAddress): void {
        if (!address) throw new Error('Contract address must not be empty');
        this.currentContractAddress = address;
    }

    async set(privateStateId: PSI, state: PS): Promise<void> {
        const contractAddress = this.requireContractAddress('set');
        const enc = await this.getEncryption();
        const ciphertext = enc.encrypt(JSON.stringify(state));
        await this.upsertPrivateState(contractAddress, privateStateId, ciphertext);
    }

    async get(privateStateId: PSI): Promise<PS | null> {
        const contractAddress = this.requireContractAddress('get');
        const db = await this.getDb();
        const row = await db.run(
            SELECT.one.from('midnight.PrivateStates').where({
                accountId: this.config.accountId,
                contractAddress,
                privateStateId
            })
        );
        if (!row) return null;
        const enc = await this.getEncryption();
        const json = enc.decrypt(row.ciphertext);
        return JSON.parse(json) as PS;
    }

    async remove(privateStateId: PSI): Promise<void> {
        const contractAddress = this.requireContractAddress('remove');
        const db = await this.getDb();
        await db.run(
            DELETE.from('midnight.PrivateStates').where({
                accountId: this.config.accountId,
                contractAddress,
                privateStateId
            })
        );
    }

    async clear(): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from('midnight.PrivateStates').where({ accountId: this.config.accountId })
        );
    }

    async setSigningKey(address: ContractAddress, signingKey: SigningKey): Promise<void> {
        const enc = await this.getEncryption();
        const ciphertext = enc.encrypt(signingKey);
        await this.upsertSigningKey(address, ciphertext);
    }

    async getSigningKey(address: ContractAddress): Promise<SigningKey | null> {
        const db = await this.getDb();
        const row = await db.run(
            SELECT.one.from('midnight.ContractSigningKeys').where({
                accountId: this.config.accountId,
                contractAddress: address
            })
        );
        if (!row) return null;
        const enc = await this.getEncryption();
        return enc.decrypt(row.ciphertext);
    }

    async removeSigningKey(address: ContractAddress): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from('midnight.ContractSigningKeys').where({
                accountId: this.config.accountId,
                contractAddress: address
            })
        );
    }

    async clearSigningKeys(): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from('midnight.ContractSigningKeys').where({ accountId: this.config.accountId })
        );
    }

    // -- Export / Import (SDK wire-format compatible) ------------------------

    async exportPrivateStates(options?: ExportPrivateStatesOptions): Promise<PrivateStateExport> {
        const contractAddress = this.requireContractAddress('exportPrivateStates');
        const maxStates = options?.maxStates ?? MAX_EXPORT_STATES;

        const db = await this.getDb();
        const rows: Array<{ privateStateId: string; ciphertext: string }> = await db.run(
            SELECT.from('midnight.PrivateStates')
                .columns('privateStateId', 'ciphertext')
                .where({ accountId: this.config.accountId, contractAddress })
        ) || [];

        if (rows.length > maxStates) {
            throw new InvalidExportFormatError(`Too many states to export (${rows.length}). Maximum allowed: ${maxStates}`);
        }

        const states: Record<string, unknown> = {};
        const inst = await this.getEncryption();
        for (const r of rows) {
            const json = inst.decrypt(r.ciphertext);
            states[r.privateStateId] = JSON.parse(json);
        }

        const payload = {
            version: CURRENT_EXPORT_VERSION,
            stateCount: rows.length,
            states
        };

        const password = options?.password ?? await this.getStoragePassword();
        validateExportPassword(password);
        const exporter = new StorageEncryption(password);
        const encryptedPayload = exporter.encrypt(JSON.stringify(payload));

        return {
            format: PRIVATE_STATE_EXPORT_FORMAT,
            encryptedPayload,
            salt: exporter.salt.toString('hex')
        };
    }

    async importPrivateStates(exportData: PrivateStateExport, options?: ImportPrivateStatesOptions): Promise<ImportPrivateStatesResult> {
        const contractAddress = this.requireContractAddress('importPrivateStates');
        const conflictStrategy = options?.conflictStrategy ?? 'error';
        const maxStates = options?.maxStates ?? MAX_EXPORT_STATES;

        if (exportData.format !== PRIVATE_STATE_EXPORT_FORMAT) {
            throw new InvalidExportFormatError('Unrecognized export format');
        }
        if (!exportData.encryptedPayload || !exportData.salt) {
            throw new InvalidExportFormatError('Missing required fields');
        }
        validateSaltHex(exportData.salt);
        if (options?.password !== undefined) validateExportPassword(options.password);

        const importPassword = options?.password ?? await this.getStoragePassword();

        let payload: { version: number; stateCount: number; states: Record<string, unknown> };
        try {
            const decryptedJson = decryptWithPassword(exportData.encryptedPayload, importPassword);
            payload = JSON.parse(decryptedJson);
        } catch {
            throw new ExportDecryptionError();
        }

        if (!payload.states ||
            typeof payload.states !== 'object' ||
            typeof payload.version !== 'number' ||
            typeof payload.stateCount !== 'number') {
            throw new ExportDecryptionError();
        }
        if (!SUPPORTED_EXPORT_VERSIONS.includes(payload.version)) {
            throw new InvalidExportFormatError(`Export version ${payload.version} is not supported. Supported versions: ${SUPPORTED_EXPORT_VERSIONS.join(', ')}`);
        }
        const stateIds = Object.keys(payload.states);
        if (stateIds.length !== payload.stateCount) {
            throw new ExportDecryptionError();
        }
        if (stateIds.length > maxStates) {
            throw new InvalidExportFormatError(`Too many states in export (${stateIds.length}). Maximum allowed: ${maxStates}`);
        }

        if (conflictStrategy === 'error') {
            let conflictCount = 0;
            for (const id of stateIds) {
                const existing = await this.get(id as PSI);
                if (existing !== null) conflictCount++;
            }
            if (conflictCount > 0) throw new ImportConflictError(conflictCount);
        }

        let imported = 0, skipped = 0, overwritten = 0;
        const enc = await this.getEncryption();
        for (const id of stateIds) {
            const existing = await this.get(id as PSI);
            const isConflict = existing !== null;
            if (isConflict && conflictStrategy === 'skip') { skipped++; continue; }
            const ciphertext = enc.encrypt(JSON.stringify(payload.states[id]));
            await this.upsertPrivateState(contractAddress, id, ciphertext);
            if (isConflict) overwritten++; else imported++;
        }
        return { imported, skipped, overwritten };
    }

    async exportSigningKeys(options?: ExportSigningKeysOptions): Promise<SigningKeyExport> {
        const maxKeys = options?.maxKeys ?? MAX_EXPORT_SIGNING_KEYS;
        const db = await this.getDb();
        const rows: Array<{ contractAddress: string; ciphertext: string }> = await db.run(
            SELECT.from('midnight.ContractSigningKeys')
                .columns('contractAddress', 'ciphertext')
                .where({ accountId: this.config.accountId })
        ) || [];
        if (rows.length > maxKeys) {
            throw new InvalidExportFormatError(`Too many signing keys to export (${rows.length}). Maximum allowed: ${maxKeys}`);
        }

        const keys: Record<string, string> = {};
        const inst = await this.getEncryption();
        for (const r of rows) keys[r.contractAddress] = inst.decrypt(r.ciphertext);

        const payload = { version: CURRENT_EXPORT_VERSION, keyCount: rows.length, keys };

        const password = options?.password ?? await this.getStoragePassword();
        validateExportPassword(password);
        const exporter = new StorageEncryption(password);
        const encryptedPayload = exporter.encrypt(JSON.stringify(payload));

        return {
            format: SIGNING_KEY_EXPORT_FORMAT,
            encryptedPayload,
            salt: exporter.salt.toString('hex')
        };
    }

    async importSigningKeys(exportData: SigningKeyExport, options?: ImportSigningKeysOptions): Promise<ImportSigningKeysResult> {
        const conflictStrategy = options?.conflictStrategy ?? 'error';
        const maxKeys = options?.maxKeys ?? MAX_EXPORT_SIGNING_KEYS;

        if (exportData.format !== SIGNING_KEY_EXPORT_FORMAT) {
            throw new InvalidExportFormatError('Unrecognized export format');
        }
        if (!exportData.encryptedPayload || !exportData.salt) {
            throw new InvalidExportFormatError('Missing required fields');
        }
        validateSaltHex(exportData.salt);
        if (options?.password !== undefined) validateExportPassword(options.password);

        const importPassword = options?.password ?? await this.getStoragePassword();

        let payload: { version: number; keyCount: number; keys: Record<string, string> };
        try {
            const decryptedJson = decryptWithPassword(exportData.encryptedPayload, importPassword);
            payload = JSON.parse(decryptedJson);
        } catch {
            throw new ExportDecryptionError();
        }
        if (!payload.keys ||
            typeof payload.keys !== 'object' ||
            typeof payload.version !== 'number' ||
            typeof payload.keyCount !== 'number') {
            throw new ExportDecryptionError();
        }
        if (!SUPPORTED_EXPORT_VERSIONS.includes(payload.version)) {
            throw new InvalidExportFormatError(`Export version ${payload.version} is not supported. Supported versions: ${SUPPORTED_EXPORT_VERSIONS.join(', ')}`);
        }
        const addresses = Object.keys(payload.keys);
        if (addresses.length !== payload.keyCount) throw new ExportDecryptionError();
        if (addresses.length > maxKeys) {
            throw new InvalidExportFormatError(`Too many keys in export (${addresses.length}). Maximum allowed: ${maxKeys}`);
        }

        if (conflictStrategy === 'error') {
            let conflictCount = 0;
            for (const a of addresses) {
                if (await this.getSigningKey(a) !== null) conflictCount++;
            }
            if (conflictCount > 0) throw new ImportConflictError(conflictCount);
        }

        let imported = 0, skipped = 0, overwritten = 0;
        const enc = await this.getEncryption();
        for (const a of addresses) {
            const existing = await this.getSigningKey(a);
            const isConflict = existing !== null;
            if (isConflict && conflictStrategy === 'skip') { skipped++; continue; }
            const ciphertext = enc.encrypt(payload.keys[a]);
            await this.upsertSigningKey(a, ciphertext);
            if (isConflict) overwritten++; else imported++;
        }
        return { imported, skipped, overwritten };
    }

    // -- Internals -----------------------------------------------------------

    private requireContractAddress(op: string): ContractAddress {
        if (this.currentContractAddress === null) {
            throw new Error(`Contract address not set. Call setContractAddress() before ${op}().`);
        }
        return this.currentContractAddress;
    }

    private async getDb(): Promise<cds.DatabaseService> {
        if (this.db) return this.db;
        await ensureNightgateModelLoaded();
        this.db = await cds.connect.to('db');
        return this.db;
    }

    private async getStoragePassword(): Promise<string> {
        const pw = await this.config.privateStoragePasswordProvider();
        if (typeof pw !== 'string' || pw.length < 16) {
            throw new Error('Private storage password must be a string of at least 16 characters');
        }
        return pw;
    }

    /**
     * Memoized per-instance StorageEncryption.
     *
     * The salt is DETERMINISTIC per (account, password) rather than random.
     * This is essential for cross-instance reads: each submission builds its
     * own provider instance, so a deploy that writes private state and a later
     * call that reads it use DIFFERENT instances. With a random per-instance
     * salt, the reader's `decrypt()` rejected the writer's blob with
     * "Salt mismatch" (the ledger never even saw it — it failed in our storage
     * layer). A deterministic salt makes every instance for the same account
     * derive the same key, so reads succeed across instances while keeping the
     * one-PBKDF2-per-instance optimization and the integrity salt-check.
     *
     * The password is already a high-entropy per-account secret (derived from
     * the wallet viewing key), so deriving the salt from it does not weaken the
     * anti-precomputation property. Export blobs still get their own fresh
     * random salt (see exportPrivateStates/exportSigningKeys).
     */
    private getEncryption(): Promise<StorageEncryption> {
        if (!this.encryptionPromise) {
            this.encryptionPromise = this.getStoragePassword().then(pw =>
                new StorageEncryption(pw, this.deriveStableSalt(pw)));
        }
        return this.encryptionPromise;
    }

    /** Deterministic 32-byte salt for this account's internal storage. */
    private deriveStableSalt(password: string): Buffer {
        return crypto
            .createHash('sha256')
            .update(`${password}|${this.config.accountId}|nightgate-private-state-salt-v1`)
            .digest();
    }

    private async upsertPrivateState(contractAddress: string, privateStateId: string, ciphertext: string): Promise<void> {
        const db = await this.getDb();
        const now = new Date().toISOString();
        const existing = await db.run(
            SELECT.one.from('midnight.PrivateStates').where({
                accountId: this.config.accountId, contractAddress, privateStateId
            })
        );
        if (existing) {
            await db.run(
                UPDATE.entity('midnight.PrivateStates')
                    .set({ ciphertext, updatedAt: now })
                    .where({ accountId: this.config.accountId, contractAddress, privateStateId })
            );
        } else {
            await db.run(INSERT.into('midnight.PrivateStates').entries({
                accountId: this.config.accountId, contractAddress, privateStateId,
                ciphertext, createdAt: now, updatedAt: now
            }));
        }
    }

    private async upsertSigningKey(contractAddress: string, ciphertext: string): Promise<void> {
        const db = await this.getDb();
        const now = new Date().toISOString();
        const existing = await db.run(
            SELECT.one.from('midnight.ContractSigningKeys').where({
                accountId: this.config.accountId, contractAddress
            })
        );
        if (existing) {
            await db.run(
                UPDATE.entity('midnight.ContractSigningKeys')
                    .set({ ciphertext, updatedAt: now })
                    .where({ accountId: this.config.accountId, contractAddress })
            );
        } else {
            await db.run(INSERT.into('midnight.ContractSigningKeys').entries({
                accountId: this.config.accountId, contractAddress,
                ciphertext, createdAt: now, updatedAt: now
            }));
        }
    }
}

// ---- Helpers --------------------------------------------------------------

function validateExportPassword(password: string): void {
    if (typeof password !== 'string' || password.length < 16) {
        throw new Error('Export password must be at least 16 characters');
    }
}

function validateSaltHex(saltHex: string): void {
    if (typeof saltHex !== 'string' || !/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length !== SALT_LENGTH * 2) {
        throw new InvalidExportFormatError('Invalid salt format');
    }
}
