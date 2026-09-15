import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    resolve: {
        // The build compiles in place, so stale `.js` twins sit next to every
        // `.ts` source. Prefer `.ts` for extensionless imports; otherwise the
        // suite would silently exercise the last build instead of the sources.
        extensions: ['.ts', '.mts', '.js', '.mjs', '.json'],
        alias: [
            // ESM-style relative imports with a `.js` extension (used by the
            // dynamic-import sites in srv/) → strip so the `.ts` source wins.
            { find: /^(\.{1,2}\/.*)\.js$/, replacement: '$1' },
            // cds-typer models; mirrors the tsconfig `#cds-models/*` path.
            {
                find: /^#cds-models\/(.*)$/,
                replacement: path.resolve(__dirname, '@cds-models') + '/$1/index.ts'
            }
        ]
    },
    test: {
        globals: true,
        environment: 'node',
        include: ['test/**/*.test.ts'],
        setupFiles: ['test/vitest.setup.ts'],
        // CAP-bootstrap suites (cds.test()) need headroom.
        testTimeout: 60000,
        hookTimeout: 60000,
        // Test files run in parallel fork processes (vitest default): each fork
        // gets its own env, in-memory DB and random ports, so the cds.test()
        // suites don't collide. Forks are killed after the run, which also ends
        // the @midnight-ntwrk ledger WASM threads.
        coverage: {
            provider: 'v8',
            reportsDirectory: 'coverage',
            // BOTH the .ts sources (vitest-graph imports) AND the in-place
            // compiled .js twins: cds.test() boots the services through Node's
            // native require, so their execution is only visible on the .js;
            // the v8 provider remaps it onto the .ts via the build sourcemaps.
            // Without the .js entries every handler exercised through the
            // booted server counts as uncovered.
            include: ['srv/**/*.ts', 'srv/**/*.js'],
            exclude: ['srv/**/*.d.ts', 'srv/**/index.{ts,js}', 'srv/types/**', 'srv/**/*.js.map']
        }
    }
});
