/**
 * Exports the signing key of one deployed contract.
 * midnight-js creates this key at deploy time. Whoever holds it can update the contract.
 * The key is stored in `ContractSigningKeys`, encrypted with the account's data key.
 *
 * The export is sealed under a password the caller chooses. It uses the same
 * format as the private-state provider's export, so `importSigningKeys` can restore it.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import { decrypt, KeyRing } from '../utils/crypto';
import { walletSessionViewingKeyBinding } from '../utils/envelope-bindings';
import { deriveAccountId, deriveStoragePassword } from './wallet-material-factory';
import { resolveAccountDek, privateStatePasswordFromDek, DEK_SCHEME } from './account-keys';
import { decryptWithPassword } from '../utils/storage-encryption';
import { buildSigningKeyExport, SigningKeyExport } from '../midnight/CapDbPrivateStateProvider';
import type { DbRunner } from '../utils/db-types';
import { NightgateError } from '../utils/errors';

const { SELECT } = cds.ql;

type Runner = DbRunner;

export class SigningKeyExportError extends NightgateError {
    constructor(status: number, message: string) {
        super('SIGNING_KEY_EXPORT_REJECTED', message, { status });
    }
}

export interface ContractSigningKeyExport extends SigningKeyExport {
    readonly contractAddress: string;
    readonly accountId: string;
}

/**
 * Export the signing key of `contractAddress` from the account behind `sessionId`.
 * A key row in the older encryption format is refused. Opening the session once upgrades it.
 */
export async function exportContractSigningKeyForSession(
    db: Runner,
    ring: KeyRing,
    sessionId: string,
    contractAddress: string,
    exportPassword: string
): Promise<ContractSigningKeyExport> {
    if (!sessionId) throw new SigningKeyExportError(400, 'sessionId is required');
    if (!contractAddress) throw new SigningKeyExportError(400, 'contractAddress is required');
    if (typeof exportPassword !== 'string' || exportPassword.length < 16) {
        throw new SigningKeyExportError(400, 'password must be at least 16 characters');
    }
    const session = await db.run(SELECT.one.from('midnight.WalletSessions').where({ sessionId }));
    if (!session || !session.isActive) throw new SigningKeyExportError(404, `Session ${sessionId} not found or inactive`);
    if (!session.encryptedViewingKey) throw new SigningKeyExportError(409, 'Session has no viewing key');
    let viewingKey: string;
    try {
        viewingKey = decrypt(session.encryptedViewingKey, ring, walletSessionViewingKeyBinding(session.sessionId));
    } catch {
        throw new SigningKeyExportError(500, 'Failed to decrypt the session viewing key (ENCRYPTION_KEY mismatch?)');
    }
    const accountId = deriveAccountId(viewingKey);
    const address = String(contractAddress).toLowerCase();
    const row = await db.run(
        SELECT.one.from('midnight.ContractSigningKeys').where({ accountId, contractAddress: address })
    );
    if (!row?.ciphertext) throw new SigningKeyExportError(404, `No signing key for contract ${address} in this session's account`);
    if (row.keyScheme !== DEK_SCHEME) {
        throw new SigningKeyExportError(409, 'Signing key row predates the account key; run a call through this session first, it migrates the row');
    }
    const dek = await resolveAccountDek({ db, ring, accountId, storagePassword: deriveStoragePassword(viewingKey), create: false });
    if (!dek) throw new SigningKeyExportError(409, 'Account has no data key yet');
    let signingKey: string;
    try {
        signingKey = decryptWithPassword(row.ciphertext, privateStatePasswordFromDek(dek, accountId));
    } catch {
        throw new SigningKeyExportError(500, 'Signing key row does not open under the account key');
    } finally {
        dek.fill(0);
    }
    const envelope = buildSigningKeyExport({ [address]: signingKey }, exportPassword);
    return { ...envelope, contractAddress: address, accountId };
}
