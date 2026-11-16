// A contract's proving files over HTTP from the server's `/zk-config/<contract>` route.
// midnight-js checks every file against the compiler's manifest served there and reads the runtime version from it.

import { FetchZkConfigProvider as MidnightFetchZkConfigProvider } from '@midnight-ntwrk/midnight-js-fetch-zk-config-provider';

export class FetchZkConfigProvider extends MidnightFetchZkConfigProvider {
    // `baseUrl` is the contract's absolute `zkConfigBaseUrl`. `options` are the integrity options of midnight-js.
    constructor(baseUrl, fetchFn, options = {}) {
        super(baseUrl, { ...options, ...(fetchFn ? { fetchFunc: fetchFn } : {}) });
    }
}
