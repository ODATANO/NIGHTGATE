/**
 * NIGHTGATE_* settings for code that runs inside the server AND ships in the
 * slim `@odatano/nightgate-tx` package (wasm-proof-provider, batch-call-scope).
 *
 * Inside the server the config table answers (defaults, validation,
 * worker_threads propagation). The package does not carry
 * `srv/utils/config`: there the environment decides. 0.5.0 imported the
 * table statically from both files and every in-process build of the SDK
 * died on load with "Cannot find module '../utils/config'".
 *
 * SPDX-License-Identifier: Apache-2.0
 */

type ConfigModule = typeof import('../utils/config');

let table: ConfigModule | null | undefined;

function serverConfig(): ConfigModule | null {
    if (table !== undefined) return table;
    try {
        table = require('../utils/config') as ConfigModule; // slim-optional: server-only, absent in the package
    } catch (e) {
        if ((e as { code?: string })?.code !== 'MODULE_NOT_FOUND') throw e;
        table = null;
    }
    return table;
}

/** The setting as the server resolves it, else the raw environment value (empty = unset). */
export function runtimeConfigEnum<T extends string>(key: string): T | undefined {
    const t = serverConfig();
    if (t) return t.configEnum<T>(key);
    const v = process.env[key];
    return v === undefined || v === '' ? undefined : (v as T);
}
