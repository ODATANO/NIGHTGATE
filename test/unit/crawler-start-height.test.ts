/**
 * Crawler catch-up start height tests
 */

jest.mock('@sap/cds', () => {
    const cds: any = {
        env: { requires: {} },
        ql: {
            SELECT: {},
            INSERT: {},
            UPDATE: {},
            DELETE: {}
        }
    };
    cds.default = cds;
    return cds;
});

import { MidnightCrawler } from '../../srv/crawler/Crawler';

describe('MidnightCrawler catch-up start height', () => {
    const crawler = new MidnightCrawler({} as any, { enabled: true });
    const getCatchUpStartHeight = (crawler as any).getCatchUpStartHeight.bind(crawler) as (state?: unknown) => number;

    it('starts from block 0 when no indexed hash exists yet', () => {
        expect(getCatchUpStartHeight()).toBe(0);
        expect(getCatchUpStartHeight({ lastIndexedHeight: 0, lastIndexedHash: null })).toBe(0);
    });

    it('continues from the next height once a tip hash exists', () => {
        expect(getCatchUpStartHeight({ lastIndexedHeight: 0, lastIndexedHash: '0xabc' })).toBe(1);
        expect(getCatchUpStartHeight({ lastIndexedHeight: 42, lastIndexedHash: '0xdef' })).toBe(43);
    });
});