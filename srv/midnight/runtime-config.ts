/**
 * Reads NIGHTGATE_* settings for code that also ships in the `@odatano/nightgate-tx` package.
 * Inside the server the settings come from the server config.
 * The package has no server config, so it reads the environment directly.
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

/** The server's value for the setting, or the raw environment value outside the server. An empty value counts as unset. */
export function runtimeConfigEnum<T extends string>(key: string): T | undefined {
    const t = serverConfig();
    if (t) return t.configEnum<T>(key);
    const v = process.env[key];
    return v === undefined || v === '' ? undefined : (v as T);
}
