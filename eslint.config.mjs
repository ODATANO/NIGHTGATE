import cds from '@sap/cds/eslint.config.mjs'
import globals from 'globals'

export default [
    {
        ignores: [
            '**/node_modules/**',
            '**/coverage/**',
            '**/gen/**',
            '@cds-models/**',
            'src/**/*.js',
            'src/**/*.d.ts',
            'src/**/*.js.map',
            'src/**/*.d.ts.map',
            'srv/**/*.js',
            'srv/**/*.d.ts',
            'srv/**/*.js.map',
            'srv/**/*.d.ts.map',
            'test/**/*.js',
            'test/**/*.d.ts',
            'scripts/**',
            'contracts/**/managed/**'
        ]
    },
    ...cds.recommended,
    {
        // The src/browser building blocks run in the browser (Lace connector),
        // not Node, so they use browser globals (WebSocket, TextEncoder, crypto,
        // fetch, localStorage, ...).
        files: ['src/browser/**/*.mjs'],
        languageOptions: {
            globals: { ...globals.browser }
        }
    }
]
