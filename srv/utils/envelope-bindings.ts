/**
 * The bindings every persisted ring envelope is written under (crypto.ts v3):
 * one purpose per column, the row's identity as subject. A value copied into
 * another row or another column does not decrypt. The rewrap tool derives the
 * same binding from the row it reads (encryption-rewrap.ts).
 * SPDX-License-Identifier: Apache-2.0
 */

import type { EnvelopeBinding } from './crypto';

/** `WalletSessions.encryptedViewingKey`, subject = the session id. */
export function walletSessionViewingKeyBinding(sessionId: string): EnvelopeBinding {
    return { purpose: 'wallet-session/viewing-key', subject: String(sessionId) };
}

/** `WalletSessions.encryptedSeedKey`, subject = the session id. */
export function walletSessionSeedBinding(sessionId: string): EnvelopeBinding {
    return { purpose: 'wallet-session/seed', subject: String(sessionId) };
}

/** `BackgroundJobs.command` (aes-gcm-v1), subject = the job id. */
export function jobCommandBinding(jobId: string): EnvelopeBinding {
    return { purpose: 'background-job/command', subject: String(jobId) };
}

/** `AccountKeys.wrappedDek`, subject = the account id. */
export function accountDekBinding(accountId: string): EnvelopeBinding {
    return { purpose: 'account-key/ring-seal', subject: String(accountId) };
}

/** `AccountKeys.wrappedDekByViewingKey` outer envelope, subject = the account id. */
export function accountDekViewingKeySealBinding(accountId: string): EnvelopeBinding {
    return { purpose: 'account-key/viewing-key-seal', subject: String(accountId) };
}
