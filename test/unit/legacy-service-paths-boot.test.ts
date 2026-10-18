/**
 * The old `/api/v1/...` paths on the booted server: answered like the new paths,
 * the agent-token lane still applies after the rewrite, a lookalike path is not rewritten.
 */

import cds from '@sap/cds';
import { describe, expect, it } from 'vitest';

process.env.AGENT_GRANTS_ENABLED = 'true';
process.env.SKIP_AUTO_INIT = 'true';

cds.User.default = (cds.User as unknown as { Anonymous: typeof cds.User.default }).Anonymous;

(cds as any).env.requires.auth = {
    kind: 'basic',
    impl: '@odatano/cap-auth',
    realm: 'nightgate',
    users: { nightgate: { password: 'op-secret', roles: ['admin'] } }
};

const cap = cds.test(__dirname + '/../..') as unknown as { url: string };
const agentToken = { 'x-agent-token': 'ngat_' + 'a'.repeat(64) };

describe('legacy service paths on the booted server', () => {
    it('answers the old indexer path like the new one', async () => {
        const now = await fetch(`${cap.url}/odata/v4/midnight-indexer/getLiveness()`);
        const old = await fetch(`${cap.url}/api/v1/indexer/getLiveness()`);
        expect(old.status).toBe(200);
        expect(((await old.json()) as { status: string }).status).toBe(((await now.json()) as { status: string }).status);
    });

    it('keeps the agent-token lane on the old service path', async () => {
        const now = await fetch(`${cap.url}/odata/v4/midnight/WalletSessions`, { headers: agentToken });
        const old = await fetch(`${cap.url}/api/v1/nightgate/WalletSessions`, { headers: agentToken });
        expect(now.status).toBe(401);
        expect(old.status).toBe(401);
        expect(old.headers.get('www-authenticate')).toBeNull();
    });

    it('does not rewrite a lookalike path', async () => {
        const res = await fetch(`${cap.url}/api/v1/nightgate-x/WalletSessions`, { headers: agentToken });
        expect(res.status).toBe(404);
    });
});
