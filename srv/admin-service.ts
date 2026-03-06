/**
 * MidnightAdminService — System Administration
 *
 * Provides session management for wallet connections.
 * Entity projections (WalletSessions) are handled by CDS automatically.
 */

import cds, { Request } from '@sap/cds';
const { SELECT, UPDATE } = cds.ql;

export default class MidnightAdminService extends cds.ApplicationService {
    private db!: any;

    async init(): Promise<void> {
        this.db = await cds.connect.to('db');

        this.on('invalidateSession', async (req: Request) => {
            const { sessionId } = req.data as { sessionId: string };

            if (!sessionId) {
                return req.reject(400, 'sessionId is required');
            }

            const session = await this.db.run(
                SELECT.one.from('midnight.WalletSessions').where({ sessionId })
            );

            if (!session) {
                return req.reject(404, `Session ${sessionId} not found`);
            }

            if (!session.isActive) {
                return req.reject(409, `Session ${sessionId} is already inactive`);
            }

            await this.db.run(
                UPDATE.entity('midnight.WalletSessions').set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null  // Clear encrypted key
                }).where({ sessionId })
            );
        });

        this.on('invalidateAllSessions', async () => {
            const result = await this.db.run(
                UPDATE.entity('midnight.WalletSessions').set({
                    isActive: false,
                    disconnectedAt: new Date().toISOString(),
                    encryptedViewingKey: null  // Clear all encrypted keys
                }).where({ isActive: true })
            );
            return result;
        });

        await super.init();
    }
}
