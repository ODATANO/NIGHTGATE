// Stores a contract's private state in the CAP database instead of the SDK's LevelDB store.
// Exports have the shape midnight-js writes, so they move between this store and a midnight-js app.
// One instance serves one account, its contracts are reached through `forContract`.

import crypto from 'crypto';
import type { SuperJSON } from 'superjson';
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
import { PrivateStates, ContractSigningKeys, type PrivateState, type ContractSigningKey } from '#cds-models/midnight';
import type { DbRunner } from '../utils/db-types';
import { bareHex } from '../utils/hex-patterns';
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

/** `value` as a signing key, or undefined when it is none. */
function asSigningKey(value: unknown): SigningKey | undefined {
    const key = value as Partial<SigningKey> | null | undefined;
    if (key && typeof key === 'object' && (key.tag === 'schnorr' || key.tag === 'ecdsa') && typeof key.value === 'string' && LEGACY_SIGNING_KEY.test(key.value)) {
        return { tag: key.tag, value: key.value };
    }
    return undefined;
}

/** A stored signing key is JSON text of `{ tag, value }`. An older row holds a bare hex Schnorr key. */
export function readStoredSigningKey(stored: string, contractAddress: string): SigningKey {
    if (LEGACY_SIGNING_KEY.test(stored)) return { tag: 'schnorr', value: stored };
    let parsed: unknown;
    try { parsed = JSON.parse(stored); } catch { parsed = undefined; }
    const key = asSigningKey(parsed);
    if (key) return key;
    throw new Error(`The signing key stored for contract '${contractAddress}' is not a valid signing key`);
}

let codec: Promise<SuperJSON> | undefined;

/** The serializer midnight-js uses for private state, with its rule for a Buffer. It keeps big integers and bytes, which plain JSON does not. */
function stateCodec(): Promise<SuperJSON> {
    codec ??= import('superjson').then(({ SuperJSON: Codec }) => {
        const own = new Codec();
        own.registerCustom<Buffer, string>({
            isApplicable: (v): v is Buffer => v instanceof Buffer,
            serialize: v => v.toString('hex'),
            deserialize: v => Buffer.from(v, 'hex')
        }, 'buffer');
        return own;
    });
    return codec;
}

// A stored state is this prefix plus the serializer's text. A row without it is plain JSON from an older version.
const STATE_PREFIX = 'sj1:';

async function encodeState(state: unknown): Promise<string> {
    return STATE_PREFIX + (await stateCodec()).stringify(state);
}

async function decodeState(stored: string): Promise<unknown> {
    return stored.startsWith(STATE_PREFIX) ? (await stateCodec()).parse(stored.slice(STATE_PREFIX.length)) : JSON.parse(stored);
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

/** The account whose rows move, and its password. Without a password nothing can be read, and every row stays. */
export interface StoredRowPasswords { accountId: string; password?: string }

/** Moves an account's private states and signing keys to another account and encrypts them with its password.
 *  A row the target already has stays, and so does a row that cannot be read. Returns how many rows moved and stayed. */
export async function movePrivateRows(
    db: DbRunner, from: StoredRowPasswords, to: { accountId: string; password: string }
): Promise<{ moved: number; left: number }> {
    const readers = new Map<string, Promise<StorageEncryption>>();
    let writer: Promise<StorageEncryption> | undefined;
    const rewritten = async (ciphertext: string | null | undefined): Promise<string | null> => {
        if (!ciphertext) return null;
        let salt: Buffer;
        try { salt = extractEncryptedComponents(Buffer.from(ciphertext, 'base64')).salt; } catch { return null; }
        const password = from.password;
        if (!password || !privateStateStableSalt(from.accountId, password).equals(salt)) return null;
        let reader = readers.get(password);
        if (!reader) readers.set(password, reader = StorageEncryption.createAsync(password, salt));
        let plain: string;
        try { plain = (await reader).decrypt(ciphertext); } catch { return null; }
        writer ??= StorageEncryption.createAsync(to.password, privateStateStableSalt(to.accountId, to.password));
        return (await writer).encrypt(plain);
    };
    let moved = 0;
    let left = 0;
    const move = async (ciphertext: string | null | undefined, taken: unknown, insert: (fresh: string) => unknown, remove: () => unknown): Promise<void> => {
        const fresh = taken ? null : await rewritten(ciphertext);
        if (fresh === null) { left++; return; }
        await insert(fresh);
        await remove();
        moved++;
    };
    try {
        const states: PrivateState[] = await db.run(SELECT.from(PrivateStates).where({ accountId: from.accountId })) ?? [];
        for (const row of states) {
            const key = { contractAddress: row.contractAddress, privateStateId: row.privateStateId };
            await move(
                row.ciphertext,
                await db.run(SELECT.one.from(PrivateStates).columns('accountId').where({ accountId: to.accountId, ...key })),
                fresh => db.run(INSERT.into(PrivateStates).entries({ ...row, accountId: to.accountId, ciphertext: fresh, keyScheme: DEK_SCHEME })),
                () => db.run(DELETE.from(PrivateStates).where({ accountId: from.accountId, ...key })));
        }
        const keys: ContractSigningKey[] = await db.run(SELECT.from(ContractSigningKeys).where({ accountId: from.accountId })) ?? [];
        for (const row of keys) {
            const key = { contractAddress: row.contractAddress };
            await move(
                row.ciphertext,
                await db.run(SELECT.one.from(ContractSigningKeys).columns('accountId').where({ accountId: to.accountId, ...key })),
                fresh => db.run(INSERT.into(ContractSigningKeys).entries({ ...row, accountId: to.accountId, ciphertext: fresh, keyScheme: DEK_SCHEME })),
                () => db.run(DELETE.from(ContractSigningKeys).where({ accountId: from.accountId, ...key })));
        }
    } finally {
        for (const key of [...readers.values(), writer]) void key?.then(k => k.clear(), () => undefined);
    }
    return { moved, left };
}

export class CapDbPrivateStateProvider<PSI extends PrivateStateId = PrivateStateId, PS = unknown> implements PrivateStateProvider<PSI, PS> {
    private db: DbRunner | undefined;
    private encryptionPromise: Promise<StorageEncryption> | undefined;

    constructor(private readonly config: CapDbPrivateStateProviderConfig) {
        if (!config.accountId) throw new Error('accountId is required');
        if (!config.privateStoragePasswordProvider) throw new Error('privateStoragePasswordProvider is required');
        if (config.db) this.db = config.db;
    }

    /** Rows are keyed by the address in lowercase hex without `0x`, the form the SDK's providers report. */
    forContract(given: ContractAddress): ContractPrivateStates<PSI, PS> {
        const contractAddress = bareHex(given);
        if (!contractAddress) throw new Error('Contract address must not be empty');
        return {
            contractAddress,
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
        const ciphertext = enc.encrypt(await encodeState(state));
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
        const stored = await this.decryptStored(row.ciphertext);
        return await decodeState(stored) as PS;
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
                contractAddress: bareHex(address)
            })
        );
        if (!row) return null;
        return readStoredSigningKey(await this.decryptStored(row.ciphertext), address);
    }

    async removeSigningKey(address: ContractAddress): Promise<void> {
        const db = await this.getDb();
        await db.run(
            DELETE.from(ContractSigningKeys).where({
                accountId: this.config.accountId,
                contractAddress: bareHex(address)
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

        // midnight-js exports each state as the serializer's text.
        const states: Record<string, string> = {};
        const serializer = await stateCodec();
        for (const r of rows) {
            const stored = await this.decryptStored(r.ciphertext);
            states[r.privateStateId] = serializer.stringify(await decodeState(stored));
        }

        const payload = { version: CURRENT_EXPORT_VERSION, exportedAt: new Date().toISOString(), stateCount: rows.length, states };
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

        let payload: { version: number; exportedAt?: unknown; stateCount: number; states: Record<string, unknown> };
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

        // An export that names its time holds each state as the serializer's text. An older one has no time and holds the state itself.
        const serializer = await stateCodec();
        const serialized = typeof payload.exportedAt === 'string';
        const incoming = new Map<string, unknown>();
        for (const id of stateIds) {
            const value = payload.states[id];
            try {
                incoming.set(id, serialized ? serializer.parse(String(value)) : value);
            } catch {
                throw new InvalidExportFormatError('Invalid private state value');
            }
        }

        let imported = 0, skipped = 0, overwritten = 0;
        const enc = await this.getEncryption();
        for (const id of stateIds) {
            const existing = await this.get(contractAddress, id as PSI);
            const isConflict = existing !== null;
            if (isConflict && conflictStrategy === 'skip') { skipped++; continue; }
            const ciphertext = enc.encrypt(await encodeState(incoming.get(id)));
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

        const keys: Record<string, SigningKey> = {};
        for (const r of rows) {
            keys[r.contractAddress] = readStoredSigningKey(await this.decryptStored(r.ciphertext), r.contractAddress);
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

        let payload: { version: number; keyCount: number; keys: Record<string, unknown> };
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

        // A key from midnight-js is `{ tag, value }`. An export of an older version of this store holds the stored text.
        const incoming = new Map<string, SigningKey>();
        for (const a of addresses) {
            const value = payload.keys[a];
            let key: SigningKey | undefined;
            try { key = typeof value === 'string' ? readStoredSigningKey(value, a) : asSigningKey(value); } catch { key = undefined; }
            if (!key) throw new InvalidExportFormatError('Invalid signing key value');
            incoming.set(a, key);
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
            const ciphertext = enc.encrypt(JSON.stringify(incoming.get(a)));
            await this.upsertSigningKey(a, ciphertext);
            if (isConflict) overwritten++; else imported++;
        }
        return { imported, skipped, overwritten };
    }

    private async getDb(): Promise<DbRunner> {
        if (this.db) return this.db;
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

    /** Fixed salt, because each submission has its own provider and must read what another wrote. Exports get a random salt.
     *  The key is derived off the event loop: this runs on the server thread for every submission. */
    private getEncryption(): Promise<StorageEncryption> {
        if (!this.encryptionPromise) {
            this.encryptionPromise = this.getStoragePassword().then(pw =>
                StorageEncryption.createAsync(pw, this.deriveStableSalt(pw)));
        }
        return this.encryptionPromise;
    }

    private deriveStableSalt(password: string): Buffer {
        return privateStateStableSalt(this.config.accountId, password);
    }

    private async decryptStored(ciphertext: string): Promise<string> {
        return (await this.getEncryption()).decrypt(ciphertext);
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

    private async upsertSigningKey(given: string, ciphertext: string): Promise<void> {
        const contractAddress = bareHex(given);
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
export function buildSigningKeyExport(keys: Record<string, SigningKey>, password: string): SigningKeyExport {
    const payload = { version: CURRENT_EXPORT_VERSION, exportedAt: new Date().toISOString(), keyCount: Object.keys(keys).length, keys };
    return sealExport(SIGNING_KEY_EXPORT_FORMAT, payload, password);
}

function validateSaltHex(saltHex: string): void {
    if (typeof saltHex !== 'string' || !/^[0-9a-fA-F]+$/.test(saltHex) || saltHex.length !== SALT_LENGTH * 2) {
        throw new InvalidExportFormatError('Invalid salt format');
    }
}
