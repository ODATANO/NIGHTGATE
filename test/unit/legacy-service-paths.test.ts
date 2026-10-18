import { beforeEach, describe, expect, it } from 'vitest';
import { rewriteLegacyServicePath, legacyServicePathMiddleware, legacyPathRequestTotals, __resetLegacyServicePathsForTests } from '../../srv/utils/legacy-service-paths';

describe('legacy service paths', () => {
    beforeEach(() => __resetLegacyServicePathsForTests());

    it('rewrites every old service path and what lies below it', () => {
        expect(rewriteLegacyServicePath('/api/v1/nightgate')).toBe('/odata/v4/midnight');
        expect(rewriteLegacyServicePath('/api/v1/nightgate/getJobStatus(jobId=1)')).toBe('/odata/v4/midnight/getJobStatus(jobId=1)');
        expect(rewriteLegacyServicePath('/api/v1/nightgate?x=1')).toBe('/odata/v4/midnight?x=1');
        expect(rewriteLegacyServicePath('/api/v1/indexer/getReadiness()')).toBe('/odata/v4/midnight-indexer/getReadiness()');
        expect(rewriteLegacyServicePath("/api/v1/verify/verifyAttestationState(contractAddress='c',payloadHash='p')"))
            .toBe("/odata/v4/midnight-verify/verifyAttestationState(contractAddress='c',payloadHash='p')");
        expect(rewriteLegacyServicePath('/api/v1/analytics/x')).toBe('/odata/v4/midnight-analytics/x');
        expect(rewriteLegacyServicePath('/api/v1/admin/x')).toBe('/odata/v4/midnight-admin/x');
    });

    it('leaves every other path alone', () => {
        expect(rewriteLegacyServicePath('/odata/v4/midnight/x')).toBeNull();
        expect(rewriteLegacyServicePath('/api/v1/nightgate-x/y')).toBeNull();
        expect(rewriteLegacyServicePath('/api/v1/nightgateevil')).toBeNull();
        expect(rewriteLegacyServicePath('/contract-manifest')).toBeNull();
        expect(rewriteLegacyServicePath('/')).toBeNull();
    });

    it('moves url and originalUrl of a request on an old path', () => {
        const req = { url: '/api/v1/verify/x', originalUrl: '/api/v1/verify/x' };
        let called = false;
        legacyServicePathMiddleware(req as never, {} as never, () => { called = true; });
        expect(called).toBe(true);
        expect(req).toEqual({ url: '/odata/v4/midnight-verify/x', originalUrl: '/odata/v4/midnight-verify/x' });

        const other = { url: '/zk-config/a/b/c', originalUrl: '/zk-config/a/b/c' };
        legacyServicePathMiddleware(other as never, {} as never, () => {});
        expect(other.url).toBe('/zk-config/a/b/c');
    });

    it('counts the requests per old path and lists every old path', () => {
        for (const url of ['/api/v1/verify/x', '/api/v1/verify/y', '/api/v1/indexer/getReadiness()', '/odata/v4/midnight/x']) {
            legacyServicePathMiddleware({ url, originalUrl: url } as never, {} as never, () => {});
        }
        const totals = legacyPathRequestTotals();
        expect(totals.get('/api/v1/verify')).toBe(2);
        expect(totals.get('/api/v1/indexer')).toBe(1);
        expect(totals.get('/api/v1/nightgate')).toBe(0);
        expect([...totals.keys()].sort()).toEqual(['/api/v1/admin', '/api/v1/analytics', '/api/v1/indexer', '/api/v1/nightgate', '/api/v1/verify']);
    });
});
