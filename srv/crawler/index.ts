/**
 * Crawler module — public API and lifecycle management
 */

import { MidnightNodeProvider } from '../providers/MidnightNodeProvider';
import { MidnightCrawler, CrawlerConfig } from './Crawler';

export { BlockProcessor } from './BlockProcessor';
export type { ProcessResult } from './BlockProcessor';
export { MidnightCrawler } from './Crawler';
export type { CrawlerConfig } from './Crawler';

let activeCrawler: MidnightCrawler | null = null;
let activeNodeProvider: MidnightNodeProvider | null = null;

/**
 * Start the crawler. Idempotent — calling twice is a no-op.
 */
export async function startCrawler(config: CrawlerConfig & { nodeUrl: string; requestTimeout?: number }): Promise<void> {
    if (activeCrawler) {
        console.warn('[Crawler] Already running');
        return;
    }

    const nodeProvider = new MidnightNodeProvider({
        nodeUrl: config.nodeUrl,
        requestTimeout: config.requestTimeout || 30000
    });

    const crawler = new MidnightCrawler(nodeProvider, config);
    await crawler.start();

    activeCrawler = crawler;
    activeNodeProvider = nodeProvider;
    console.log('[Crawler] Started');
}

/**
 * Stop the crawler and disconnect the node provider.
 */
export async function stopCrawler(): Promise<void> {
    if (activeCrawler) {
        await activeCrawler.stop();
        activeCrawler = null;
    }
    if (activeNodeProvider) {
        try {
            await activeNodeProvider.disconnect();
        } catch { /* ignore disconnect errors */ }
        activeNodeProvider = null;
    }
    console.log('[Crawler] Stopped');
}
