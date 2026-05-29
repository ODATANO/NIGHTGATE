/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
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
