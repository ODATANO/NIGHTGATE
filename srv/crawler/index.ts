import { MidnightNodeProvider } from '../providers/MidnightNodeProvider';
import { installCrawlerFaultGuard } from './crawler-fault-guard';
import { configBool } from '../utils/config';
import { MidnightCrawler, CrawlerConfig } from './Crawler';
import cds from '@sap/cds';
const log = cds.log('nightgate:crawler');

export { BlockProcessor } from './BlockProcessor';
export type { ProcessResult } from './BlockProcessor';
export { MidnightCrawler } from './Crawler';
export type { CrawlerConfig } from './Crawler';

let activeCrawler: MidnightCrawler | null = null;
let activeNodeProvider: MidnightNodeProvider | null = null;

/**
 * Starts the crawler. Calling it while the crawler runs does nothing.
 */
export async function startCrawler(config: CrawlerConfig & { nodeUrl: string; requestTimeout?: number }): Promise<void> {
    if (activeCrawler) {
        if (activeCrawler.isActive()) {
            log.warn('Already running');
            return;
        }
        // The old crawler stopped after a permanent failure. Release it before starting a new one.
        await stopCrawler();
    }

    // Installed together with the crawler, because only the crawler depends on a node
    // that may answer slowly or not at all.
    if (configBool('NIGHTGATE_CRAWLER_FAULT_GUARD') !== false) installCrawlerFaultGuard();

    const nodeProvider = new MidnightNodeProvider({
        nodeUrl: config.nodeUrl,
        requestTimeout: config.requestTimeout || 30000
    });

    const crawler = new MidnightCrawler(nodeProvider, config);
    try {
        await crawler.start();
    } catch (err) {
        try {
            await nodeProvider.disconnect();
        } catch {
            // Ignore disconnect errors while handling startup failure.
        }
        throw err;
    }

    activeCrawler = crawler;
    activeNodeProvider = nodeProvider;
    log.info('Started');
}

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
    log.info('Stopped');
}

/** True while the crawler is indexing. False after a stop or a permanent failure. */
export function isCrawlerRunning(): boolean {
    return activeCrawler !== null && activeCrawler.isActive();
}
