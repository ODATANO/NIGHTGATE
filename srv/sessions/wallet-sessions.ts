/**
 * Wallet Session Management — connect, disconnect, cleanup
 *
 * Extracted from MidnightService to separate session concerns
 * from OData read handlers.
 */

import cds, { Request } from '@sap/cds';
const { SELECT, INSERT, UPDATE } = cds.ql;
import { getEncryptionKey, encrypt, hashViewingKey } from '../utils/crypto';
import { validateViewingKey } from '../utils/validation';
import { RateLimiter } from '../utils/rate-limiter';

const walletRateLimiter = new RateLimiter({
    windowMs: 60 * 1000,
    maxRequests: 10
});

export function registerWalletSessionHandlers(srv: cds.ApplicationService, db: any): void {
    srv.on('connectWallet', 'WalletSessions', async (req: Request) => {
        const clientKey = (req as any)?._.req?.ip || 'global';
        const rateResult = walletRateLimiter.check(clientKey);
        if (!rateResult.allowed) {
            return req.reject(429, `Rate limited. Retry after ${Math.ceil(rateResult.retryAfterMs / 1000)}s`);
        }

        const { viewingKey } = req.data as { viewingKey: string };

        const validationError = validateViewingKey(viewingKey);
        if (validationError) {
            return req.reject(400, validationError);
        }

        const encKey = getEncryptionKey();
        const vkHash = hashViewingKey(viewingKey);
        const encryptedVk = encrypt(viewingKey, encKey);
        const sessionToken = cds.utils.uuid();

        const midnightConfig = (cds.env as any).requires?.midnight || {};
        const sessionTtlMs = midnightConfig.sessionTtlMs || 24 * 60 * 60 * 1000;
        const expiresAt = new Date(Date.now() + sessionTtlMs).toISOString();

        const session = {
            ID: cds.utils.uuid(),
            sessionId: cds.utils.uuid(),
            viewingKeyHash: vkHash,
            encryptedViewingKey: encryptedVk,
            sessionToken,
            connectedAt: new Date().toISOString(),
            expiresAt,
            isActive: true
        };

        await db.run(INSERT.into('midnight.WalletSessions').entries(session));

        return {
            ID: session.ID,
            sessionId: session.sessionId,
            sessionToken,
            connectedAt: session.connectedAt,
            expiresAt: session.expiresAt,
            isActive: true
        };
    });

    srv.on('disconnectWallet', 'WalletSessions', async (req: Request) => {
        const { sessionId } = req.data as { sessionId: string };
        if (!sessionId) return req.reject(400, 'sessionId is required');

        const session = await db.run(
            SELECT.one.from('midnight.WalletSessions').where({ sessionId })
        );

        if (!session) {
            return req.reject(404, 'Session not found');
        }

        if (session.expiresAt && new Date(session.expiresAt) < new Date()) {
            await db.run(
                UPDATE.entity('midnight.WalletSessions')
                    .set({ isActive: false, encryptedViewingKey: null })
                    .where({ sessionId })
            );
            return req.reject(410, 'Session expired');
        }

        await db.run(
            UPDATE.entity('midnight.WalletSessions')
                .set({
                    disconnectedAt: new Date().toISOString(),
                    isActive: false,
                    encryptedViewingKey: null
                })
                .where({ sessionId })
        );
    });
}

/**
 * Start periodic cleanup of expired wallet sessions.
 * Returns the timer handle for cleanup on shutdown.
 */
export function startSessionCleanup(db: any): ReturnType<typeof setInterval> {
    const SESSION_CLEANUP_INTERVAL = 15 * 60 * 1000;
    const timer = setInterval(async () => {
        try {
            await db.run(
                UPDATE.entity('midnight.WalletSessions')
                    .set({ isActive: false, encryptedViewingKey: null })
                    .where({ isActive: true, expiresAt: { '<': new Date().toISOString() } })
            );
        } catch { /* ignore cleanup errors */ }
    }, SESSION_CLEANUP_INTERVAL);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    return timer;
}
