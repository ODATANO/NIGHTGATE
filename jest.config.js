/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // CAP-bootstrap suites (cds.test()) can exceed Jest's 5s default under
  // --runInBand + coverage; give every test headroom so the standard run is
  // not machine-speed-dependent.
  testTimeout: 60000,
  // The @midnight-ntwrk ledger WASM (loaded by the wallet/SDK suites) spawns
  // threads that expose no teardown API and are invisible to
  // --detectOpenHandles. They intermittently keep the process alive after the
  // run ("Jest did not exit one second after..."), deterministically so under
  // --runInBand. All 54 suites pass and every subset exits cleanly, so this is
  // not a leak in our test code; force the exit once the run has completed.
  // Remove when the SDK offers an explicit WASM shutdown hook.
  forceExit: true,
  roots: ['<rootDir>/test'],
  setupFilesAfterEnv: ['<rootDir>/test/jest.setup.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'srv/**/*.ts',
    '!srv/**/*.d.ts',
    '!srv/**/index.ts',
    '!srv/types/**/*.ts'
  ],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: 'tsconfig.json',
      useESM: false,
      diagnostics: {
        // 2307: module not found (CDS-typer generated types under @cds-models)
        // 2769: cds.ql overload signature mismatches (deep CAP query DSL types)
        // 151002: ts-jest cache-related advisory
        // (TS7016 + 2339 used to be here for @sap/cds; resolved by adding @cap-js/cds-types to tsconfig)
        // (TS18046 used to be here for `unknown` SDK objects; resolved by switching to `any` in providers.ts)
        ignoreCodes: [2307, 2769, 151002]
      }
    }]
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1'
  },
  coverageDirectory: 'coverage',
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/test/',
    '/coverage/'
  ]
};
