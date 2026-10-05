/**
 * The context each encrypted database value is bound to: a purpose per column and the row id.
 * An encrypted value copied into another row or column will not decrypt.
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

/** Content of a disclosure to token holders, subject = the grant id. */
export function holderDisclosureContentBinding(grantId: string): EnvelopeBinding {
    return { purpose: 'holder-disclosure/content', subject: grantId };
}

/** `AccountKeys.wrappedDekByViewingKey` outer envelope, subject = the account id. */
export function accountDekViewingKeySealBinding(accountId: string): EnvelopeBinding {
    return { purpose: 'account-key/viewing-key-seal', subject: String(accountId) };
}
