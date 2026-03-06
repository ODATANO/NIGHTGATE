import cds from '@sap/cds/eslint.config.mjs'

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
            'scripts/**'
        ]
    },
    ...cds.recommended
]
