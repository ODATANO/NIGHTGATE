/** `runtimeVersionProblem`: a lineage package built for another compact-runtime fails before proving (`src/txbuilder/index.mjs`). */

import { describe, it, expect } from 'vitest';

const importBuilder = () => import('../../src/txbuilder/index.mjs' as string);

describe('runtimeVersionProblem', () => {
    it('passes a package of the same major.minor and one that says nothing', async () => {
        const { runtimeVersionProblem } = await importBuilder();
        expect(runtimeVersionProblem({ compactRuntime: '0.16.0' }, '0.16.3')).toBeNull();
        expect(runtimeVersionProblem({ compactRuntime: '0.16.0' }, '0.16.0-rc.1')).toBeNull();
        expect(runtimeVersionProblem({}, '0.16.0')).toBeNull();
        expect(runtimeVersionProblem(undefined, '0.16.0')).toBeNull();
    });

    it('names both versions when the minor differs', async () => {
        const { runtimeVersionProblem } = await importBuilder();
        const problem = runtimeVersionProblem({ compactRuntime: '0.17.0' }, '0.16.0');
        expect(problem).toMatch(/compiled for compact-runtime 0\.17\.0/);
        expect(problem).toMatch(/runtime is 0\.16\.0/);
        expect(runtimeVersionProblem({ compactRuntime: '1.0.0' }, '0.16.0')).not.toBeNull();
    });

    it('defaults to the runtime this builder loaded', async () => {
        const { runtimeVersionProblem } = await importBuilder();
        const { versionString } = await import('@midnight-ntwrk/compact-runtime' as string);
        expect(runtimeVersionProblem({ compactRuntime: versionString })).toBeNull();
    });
});
