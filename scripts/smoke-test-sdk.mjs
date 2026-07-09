// Native Node ESM smoke test for the Midnight SDK packages.
// Verifies each package loads and exposes at least one named export.
// Run with: node scripts/smoke-test-sdk.mjs

const packages = [
    '@midnight-ntwrk/midnight-js-contracts',
    '@midnight-ntwrk/midnight-js-indexer-public-data-provider',
    '@midnight-ntwrk/midnight-js-http-client-proof-provider',
    '@midnight-ntwrk/midnight-js-node-zk-config-provider',
    '@midnight-ntwrk/midnight-js-level-private-state-provider',
    '@midnight-ntwrk/compact-runtime',
    '@midnight-ntwrk/ledger-v8',
    '@midnightntwrk/wallet-sdk-facade'
];

let failures = 0;
for (const pkg of packages) {
    try {
        const mod = await import(pkg);
        const keys = Object.keys(mod).filter(k => k !== 'default');
        const defaultKeys = mod.default && typeof mod.default === 'object'
            ? Object.keys(mod.default).slice(0, 5)
            : [];
        console.log(`OK   ${pkg}`);
        console.log(`     named exports (${keys.length}): ${keys.slice(0, 8).join(', ')}${keys.length > 8 ? ', ...' : ''}`);
        if (defaultKeys.length) {
            console.log(`     default.* (sample): ${defaultKeys.join(', ')}`);
        }
    } catch (err) {
        failures++;
        console.error(`FAIL ${pkg}`);
        console.error(`     ${err.message.split('\n')[0]}`);
    }
}

console.log();
console.log(failures === 0 ? `All ${packages.length} packages loaded.` : `${failures} of ${packages.length} packages FAILED to load.`);
process.exit(failures === 0 ? 0 : 1);
