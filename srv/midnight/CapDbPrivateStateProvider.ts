// Stores a contract's private state in the CAP database instead of the SDK's LevelDB store.
// Exports use the LevelDB format. One instance serves one account, its contracts are reached through `forContract`.

import crypto from 'crypto';
import { NightgateError } from '../utils/errors';
import cds from '@sap/cds';
const { SELECT, INSERT, UPDATE, DELETE } = cds.ql;
import {
    StorageEncryption,
    decryptWithPassword,
    extractEncryptedComponents,
    SALT_LENGTH
} from '../utils/storage-encryption';
import { DEK_SCHEME } from '../submission/account-keys';
import { ensureNightgateModelLoaded } from '../utils/cds-model';
import { PrivateStates, ContractSigningKeys } from '#cds-models/midnight';
import type { DbRunner } from '../utils/db-types';
import type {
    ContractPrivateStates, ExportPrivateStatesOptions, ExportSigningKeysOptions, ImportPrivateStatesOptions, ImportPrivateStatesResult,
    ImportSigningKeysOptions, ImportSigningKeysResult, PrivateStateExport, PrivateStateId, PrivateStateProvider, SigningKeyExport
} from '@midnight-ntwrk/midnight-js-types';

export type { SigningKeyExport };

const MAX_EXPORT_STATES = 10_000;
const MAX_EXPORT_SIGNING_KEYS = 10_000;
const PRIVATE_STATE_EXPORT_FORMAT = 'midnight-private-state-export';
const SIGNING_KEY_EXPORT_FORMAT = 'midnight-signing-key-export';
const CURRENT_EXPORT_VERSION = 1;
const SUPPORTED_EXPORT_VERSIONS = [1];

type ContractAddress = string;
type SigningKey = Parameters<PrivateStateProvider['setSigningKey']>[1];

const LEGACY_SIGNING_KEY = /^[0-9a-fA-F]{64}$/;

/** A stored signing key is JSON text of `{ tag, value }`. An older row holds a bare hex Schnorr key. */
function readStoredSigningKey(stored: string, contractAddress: string): SigningKey {
    if (LEGACY_SIGNING_KEY.test(stored)) return { tag: 'schnorr', value: stored };
    let parsed: unknown;
    try { parsed = JSON.parse(stored); } catch { parsed = undefined; }
    const key = parsed as Partial<SigningKey> | undefined;
    if (key && (key.tag === 'schnorr' || key.tag === 'ecdsa') && typeof key.value === 'string' && LEGACY_SIGNING_KEY.test(key.value)) {
        return { tag: key.tag, value: key.value };
    }
    throw new Error(`The signing key stored for contract '${contractAddress}' is not a valid signing key`);
}

// Errors (names match SDK convention)

export class ExportDecryptionError extends NightgateError {
    constructor() { super('PRIVATE_STATE_EXPORT_UNREADABLE', 'Failed to decrypt export'); }
}
export class InvalidExportFormatError extends NightgateError {
    constructor(msg: string) { super('PRIVATE_STATE_EXPORT_INVALID', msg); }
}
export class ImportConflictError extends NightgateError {
    constructor(conflictCount: number) {
        super('PRIVATE_STATE_IMPORT_CONFLICT', `Import aborted: ${conflictCount} conflict(s) detected and conflictStrategy is 'error'`);
    }
}

export interface CapDbPrivateStateProviderConfig {
    accountId: string;
    /** The account's storage password. Every row is written with it. */
    privateStoragePasswordProvider: () => Promise<string> | string;
    /** Older passwords, used only for reading. A row opened with one is saved again with the current password. */
    privateStoragePasswordFallbacks?: () => Promise<string[]> | string[];
    db?: DbRunner;
}

const PRIVATE_STATE_SALT_LABEL = 'nightgate-private-state-salt-v1';

/** Same account and password give the same salt, so a row's salt shows which password wrote it. */
export function privateStateStableSalt(accountId: string, password: string): Buffer {
    return crypto
        .createHash('sha256')
        .update(`${password}|${accountId}|${PRIVATE_STATE_SALT_LABEL}`)
        .digest();
}

export class CapDbPrivateStateProvider<PSI extends PrivateStateId = PrivateStateId, PS = unknown> implements PrivateStateProvider<PSI, PS> {
    private db: DbRunner | undefined;
    private encryptionPromise: Promise<StorageEncryption> | undefined;

    constructor(private readonly config: CapDbPrivateStateProviderConfig) {
        if (!config.accountId) throw new Error('accountId is required');
        if (!config.privateStoragePasswordProvider) throw new Error('privateStoragePasswordProvider is required');
        if (config.db) this.db = config.db;
    }

    /** Rows are keyed by the address as given. The view reports it in lower case, as the SDK's providers do. */
    forContract(contractAddress: ContractAddress): ContractPrivateStates<PSI, PS> {
        if (!contractAddress) throw new Error('Contract address must not be empty');
        return {
            contractAddress: contractAddress.toLowerCase(),
            set: (privateStateId, state) => this.set(contractAddress, privateStateId, state),
            get: (privateStateId) => this.get(contractAddress, privateStateId),
            remove: (privateStateId) => this.remove(contractAddress, privateStateId),
            clear: () => this.clear(contractAddress),
            exportPrivateStates: (options) => this.exportPrivateStates(contractAddress, options),
            importPrivateStates: (exportData, options) => this.importPrivateStates(contractAddress, exportData, options)
        };
    }

    async clearAll(): Promise<void> {
        const db = await this.getDb();
        await db.run(DELETE.from(PrivateStates).where({ accountId: this.config.accountId }));
    }

    private async set(contractAddress: ContractAddress, privateStateId: PSI, state: PS): Promise<void> {
        const enc = await this.getEncryption();
        const ciphertext = enc.encrypt(JSON.stringify(state));
        await this.upsertPrivateState(contractAddress, privateStateId, ciphertext);
    }

    private async get(contractAddress: ContractAddress, privateStateId: PSI): Promise<PS | null> {
        const db = await this.getDb();
        const row = await db.run(
            SELECT.one.from(PrivateStates).where({
                accountId: this.config.accountId,
                contractAddress,
                privateStateId
            })
        );
        if (!row) return null;
        const json = await this.decryptStored(row.ciphertext, fresh => this.upsertPrivateState(contractAddress, privateStateId, fresh));
        return JSON.parse(json) as PS;
    }

    private async remove(contractAddress: ContractAddress, privateStateId: PSI): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from(PrivateStates).where({
                accountId: this.config.accountId,
                contractAddress,
                privateStateId
            })
        );
    }

    private async clear(contractAddress: ContractAddress): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from(PrivateStates).where({ accountId: this.config.accountId, contractAddress })
        );
    }

    async setSigningKey(address: ContractAddress, signingKey: SigningKey): Promise<void> {
        const enc = await this.getEncryption();
        const ciphertext = enc.encrypt(JSON.stringify(signingKey));
        await this.upsertSigningKey(address, ciphertext);
    }

    async getSigningKey(address: ContractAddress): Promise<SigningKey | null> {
        const db = await this.getDb();
        const row = await db.run(
            SELECT.one.from(ContractSigningKeys).where({
                accountId: this.config.accountId,
                contractAddress: address
            })
        );
        if (!row) return null;
        return readStoredSigningKey(await this.decryptStored(row.ciphertext, fresh => this.upsertSigningKey(address, fresh)), address);
    }

    async removeSigningKey(address: ContractAddress): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from(ContractSigningKeys).where({
                accountId: this.config.accountId,
                contractAddress: address
            })
        );
    }

    async clearSigningKeys(): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from(ContractSigningKeys).where({ accountId: this.config.accountId })
        );
    }

    private async exportPrivateStates(contractAddress: ContractAddress, options?: ExportPrivateStatesOptions): Promise<PrivateStateExport> {
        const maxStates = options?.maxStates ?? MAX_EXPORT_STATES;

        const db = await this.getDb();
        const rows: Array<{ privateStateId: string; ciphertext: string }> = await db.run(
            SELECT.from(PrivateStates)
                .columns('privateStateId', 'ciphertext')
                .where({ accountId: this.config.accountId, contractAddress })
        ) || [];

        if (rows.length > maxStates) {
            throw new InvalidExportFormatError(`Too many states to export (${rows.length}). Maximum allowed: ${maxStates}`);
        }

        const states: Record<string, unknown> = {};
        for (const r of rows) {
            const json = await this.decryptStored(r.ciphertext, fresh => this.upsertPrivateState(contractAddress, r.privateStateId, fresh));
            states[r.privateStateId] = JSON.parse(json);
        }

        const payload = { version: CURRENT_EXPORT_VERSION, stateCount: rows.length, states };
        return sealExport(PRIVATE_STATE_EXPORT_FORMAT, payload, options?.password ?? await this.getStoragePassword());
    }

    private async importPrivateStates(contractAddress: ContractAddress, exportData: PrivateStateExport, options?: ImportPrivateStatesOptions): Promise<ImportPrivateStatesResult> {
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
                const existing = await this.get(contractAddress, id as PSI);
                if (existing !== null) conflictCount++;
            }
            if (conflictCount > 0) throw new ImportConflictError(conflictCount);
        }

        let imported = 0, skipped = 0, overwritten = 0;
        const enc = await this.getEncryption();
        for (const id of stateIds) {
            const existing = await this.get(contractAddress, id as PSI);
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
            SELECT.from(ContractSigningKeys)
                .columns('contractAddress', 'ciphertext')
                .where({ accountId: this.config.accountId })
        ) || [];
        if (rows.length > maxKeys) {
            throw new InvalidExportFormatError(`Too many signing keys to export (${rows.length}). Maximum allowed: ${maxKeys}`);
        }

        const keys: Record<string, string> = {};
        for (const r of rows) {
            keys[r.contractAddress] = await this.decryptStored(r.ciphertext, fresh => this.upsertSigningKey(r.contractAddress, fresh));
        }
        return buildSigningKeyExport(keys, options?.password ?? await this.getStoragePassword());
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

    private async getDb(): Promise<DbRunner> {
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

    /** Fixed salt, because each submission has its own provider and must read what another wrote. Exports get a random salt. */
    private getEncryption(): Promise<StorageEncryption> {
        if (!this.encryptionPromise) {
            this.encryptionPromise = this.getStoragePassword().then(pw =>
                new StorageEncryption(pw, this.deriveStableSalt(pw)));
        }
        return this.encryptionPromise;
    }

    private deriveStableSalt(password: string): Buffer {
        return privateStateStableSalt(this.config.accountId, password);
    }

    /** Decrypts with the current password, or with the older password that matches the salt. In that case the row is saved again. */
    private async decryptStored(ciphertext: string, rewrite: (fresh: string) => Promise<void>): Promise<string> {
        const enc = await this.getEncryption();
        try {
            return enc.decrypt(ciphertext);
        } catch (primary) {
            const fallbacks = await this.config.privateStoragePasswordFallbacks?.() ?? [];
            let salt: Buffer;
            try { salt = extractEncryptedComponents(Buffer.from(ciphertext, 'base64')).salt; } catch { throw primary; }
            for (const password of fallbacks) {
                if (!this.deriveStableSalt(password).equals(salt)) continue;
                const plain = decryptWithPassword(ciphertext, password);
                try { await rewrite(enc.encrypt(plain)); } catch { /* the next read rewrites */ }
                return plain;
            }
            throw primary;
        }
    }

    private async upsertPrivateState(contractAddress: string, privateStateId: string, ciphertext: string): Promise<void> {
        const db = await this.getDb();
        const now = new Date().toISOString();
        const existing = await db.run(
            SELECT.one.from(PrivateStates).where({
                accountId: this.config.accountId, contractAddress, privateStateId
            })
        );
        if (existing) {
            await db.run(
                UPDATE.entity(PrivateStates)
                    .set({ ciphertext, keyScheme: DEK_SCHEME, updatedAt: now })
                    .where({ accountId: this.config.accountId, contractAddress, privateStateId })
            );
        } else {
            await db.run(INSERT.into(PrivateStates).entries({
                accountId: this.config.accountId, contractAddress, privateStateId,
                ciphertext, keyScheme: DEK_SCHEME, createdAt: now, updatedAt: now
            }));
        }
    }

    private async upsertSigningKey(contractAddress: string, ciphertext: string): Promise<void> {
        const db = await this.getDb();
        const now = new Date().toISOString();
        const existing = await db.run(
            SELECT.one.from(ContractSigningKeys).where({
                accountId: this.config.accountId, contractAddress
            })
        );
        if (existing) {
            await db.run(
                UPDATE.entity(ContractSigningKeys)
                    .set({ ciphertext, keyScheme: DEK_SCHEME, updatedAt: now })
                    .where({ accountId: this.config.accountId, contractAddress })
            );
        } else {
            await db.run(INSERT.into(ContractSigningKeys).entries({
                accountId: this.config.accountId, contractAddress,
                ciphertext, keyScheme: DEK_SCHEME, createdAt: now, updatedAt: now
            }));
        }
    }
}

function validateExportPassword(password: string): void {
    if (typeof password !== 'string' || password.length < 16) {
        throw new Error('Export password must be at least 16 characters');
    }
}

/** Encrypts an export payload with `password` and wipes the derived key afterwards. */
function sealExport<F extends string>(format: F, payload: object, password: string): { format: F; encryptedPayload: string; salt: string } {
    validateExportPassword(password);
    const exporter = new StorageEncryption(password);
    try {
        return { format, encryptedPayload: exporter.encrypt(JSON.stringify(payload)), salt: exporter.salt.toString('hex') };
    } finally {
        exporter.clear();
    }
}

/** Packs already decrypted signing keys into an export encrypted with `password`. */
export function buildSigningKeyExport(keys: Record<string, string>, password: string): SigningKeyExport {
    return sealExport(SIGNING_KEY_EXPORT_FORMAT, { version: CURRENT_EXPORT_VERSION, keyCount: Object.keys(keys).length, keys }, password);
}

function validateSaltHex(saltHex: string): void {
    if (typeof saltHex !== 'string' || !/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length !== SALT_LENGTH * 2) {
        throw new InvalidExportFormatError('Invalid salt format');
    }
}
