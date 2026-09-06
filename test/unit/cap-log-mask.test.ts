// CAP's JSON log format copies every request header into the log line and
// masks only what `cds.env.log.mask_headers` names. The plugin adds the agent
// token header; this pins both the helper and the formatter's behaviour.
import { describe, it, expect, afterEach } from 'vitest';
import cds from '@sap/cds';
import { applyLogHeaderMask, masksAgentToken, AGENT_TOKEN_HEADER_MASK } from '../../src/cap-log-mask';

describe('agent token never reaches the JSON request log', () => {
    afterEach(() => { (cds as any).context = undefined; });

    it('applyLogHeaderMask appends the mask once and keeps the host list', () => {
        const env: { log?: Record<string, unknown> } = { log: { mask_headers: ['/authorization/i'] } };
        expect(applyLogHeaderMask(env)).toBe(true);
        expect(env.log!.mask_headers).toEqual(['/authorization/i', AGENT_TOKEN_HEADER_MASK]);
        expect(applyLogHeaderMask(env)).toBe(false);
        expect(applyLogHeaderMask({})).toBe(true);
    });

    it('a look-alike mask that does not match the header name does not count as protection', () => {
        expect(masksAgentToken(['/x-agent-token-signature/i'])).toBe(false);
        expect(masksAgentToken(['/agent-token/i'])).toBe(true);
        expect(masksAgentToken(['x-agent-token'])).toBe(true);
        expect(masksAgentToken(['/(/'])).toBe(false);   // an invalid pattern never hides anything
        const env: { log?: Record<string, unknown> } = { log: { mask_headers: ['/x-agent-token-signature/i'] } };
        expect(applyLogHeaderMask(env)).toBe(true);
        expect(env.log!.mask_headers).toEqual(['/x-agent-token-signature/i', AGENT_TOKEN_HEADER_MASK]);
    });

    it('every entry point loads the mask bootstrap before any other Nightgate module (imports evaluate in order)', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs'); const path = require('node:path');
        const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8') as string;
        const firstImport = (src: string) => { const m = src.match(/^import .*$/m); return m ? m[0] : ''; };
        expect(firstImport(read('src/plugin.ts'))).toBe("import './cap-log-mask-boot';");
        expect(firstImport(read('srv/server.ts'))).toBe("import '../src/cap-log-mask-boot';");
        const entry = read('cds-plugin.js');
        expect(entry.indexOf("require('./src/cap-log-mask-boot')")).toBeGreaterThan(-1);
        expect(entry.indexOf("require('./src/cap-log-mask-boot')")).toBeLessThan(entry.indexOf("require('./src/plugin')"));
        // the bootstrap itself imports nothing from Nightgate but the mask helper
        const boot = read('src/cap-log-mask-boot.ts');
        expect(boot.match(/^import .* from '\.\/(?!cap-log-mask')/m)).toBeNull();
    });

    it("CAP's json formatter prints *** for x-agent-token once the mask is configured", () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const format = require('@sap/cds/lib/log/format/json');
        const env: any = (cds as any).env;
        const before = env.log.mask_headers;
        // A host list with a look-alike entry: the real mask is still added.
        env.log.mask_headers = ['/authorization/i', '/cookie/i', '/x-agent-token-signature/i'];
        applyLogHeaderMask(env);
        const ctx = new (cds as any).EventContext({ id: 'corr-1' });
        ctx.http = { req: { headers: { 'x-agent-token': 'ngat_' + 'a'.repeat(64), 'x-forwarded-for': '10.0.0.9', authorization: 'Basic abc' } } };
        try {
            // The formatter returns the console arguments: one JSON string.
            const out = (cds as any)._with(ctx, () => format.call({}, 'odata', 3, 'GET /api/v1/nightgate/getJobStatus'));
            const line = JSON.parse(String(Array.isArray(out) ? out[0] : out));
            expect(line.x_agent_token).toBe('***');
            expect(line.authorization).toBe('***');
            expect(line.x_forwarded_for).toBe('10.0.0.9');
        } finally {
            env.log.mask_headers = before;
        }
    });
});
