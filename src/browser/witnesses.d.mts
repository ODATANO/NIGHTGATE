// Declaration twin for `import ... from './witnesses.mjs'` (NodeNext resolves
// an .mjs import to .d.mts). The declarations live in witnesses.d.ts, which
// index.d.ts also consumes.
export * from './witnesses.js';
