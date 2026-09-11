/**
 * Custody export of one contract's signing key (the contract's maintenance
 * authority, sampled by midnight-js at deploy time and stored in
 * `ContractSigningKeys` under the account DEK).
 *
 * The key is read through the session that deployed the contract: the ring
 * opens the session's viewing key, the viewing key names the account, the
 * account DEK opens the row. The result is the same `midnight-signing-key-export`
 * envelope the private-state provider produces for a whole account, sealed
 * under a caller-chosen export password, so `importSigningKeys` restores it.
 * SPDX-License-Identifier: Apache-2.0
 */

import cds from '@sap/cds';
import { decrypt, KeyRing } from '../utils/crypto';
import { walletSessionViewingKeyBinding } from '../utils/envelope-bindings';
import { deriveAccountId, deriveStoragePassword } from './wallet-material-factory';
import { resolveAccountDek, privateStatePasswordFromDek, DEK_SCHEME } from './account-keys';
import { decryptWithPassword } from '../utils/storage-encryption';
import { buildSigningKeyExport, SigningKeyExport } from '../midnight/CapDbPrivateStateProvider';

const { SELECT } = cds.ql;

type Runner = { run: (q: any) => Promise<any> };

export class SigningKeyExportError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = 'SigningKeyExportError';
        this.status = status;
    }
}

export interface ContractSigningKeyExport extends SigningKeyExport {
    readonly contractAddress: string;
    readonly accountId: string;
}

/**
 * Export the signing key of `contractAddress` held by the account behind
 * `sessionId`. Fails closed: an inactive session, a session without a
 * viewing key, a missing key row, a row still under a pre-DEK derivation
 * (a session read migrates it) and a short export password are all refused.
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
