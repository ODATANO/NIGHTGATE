// The client's answer types are written from the server's model by `npm run client:types`.
// These tests fail when the declaration file is behind the model or carries an untyped answer.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error plain ESM script without a declaration file
import { ANSWERS, START, END, clientAnswerTypes, loadModel, withAnswerTypes } from '../../scripts/print-client-types.mjs';

const read = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const answerOf = (operation: string) => operation[0].toUpperCase() + operation.slice(1) + 'Answer';

describe('client answer types', () => {
    it('the block in client.d.ts is what the model gives now', async () => {
        const declared = read('src/sdk/client.d.ts');
        const fresh = withAnswerTypes(declared, clientAnswerTypes(await loadModel()));
        expect(fresh === declared, 'src/sdk/client.d.ts is behind the model: run `npm run client:types`').toBe(true);
        expect(declared.indexOf(START)).toBeGreaterThan(0);
        expect(declared.indexOf(END)).toBeGreaterThan(declared.indexOf(START));
    }, 60_000);

    it('every listed operation has a client method that returns its answer type', () => {
        const declared = read('src/sdk/client.d.ts');
        const operations = (Object.values(ANSWERS) as string[][]).flat().map(path => path.split('/').pop()!);
        expect(operations).toHaveLength(17);
        for (const operation of operations) {
            expect(declared, operation).toMatch(new RegExp(`\\b${operation}\\([^)]*\\): Promise<${answerOf(operation)}( \\| null)?>;`));
        }
    });

    it('a field the model marks `not null` is not nullable, any other one is, and a list is never null', async () => {
        const csn = await loadModel();
        const text = clientAnswerTypes(csn).join('\n');
        expect(text).toContain('    verified: boolean;\n    granted: boolean;\n    level: number | null;');
        expect(text).toContain('    jobId: string | null;');
        expect(text).toContain('    shieldedTokens: Array<{ tokenType: string; amount: string; }>;');
        expect(text).not.toMatch(/Array<[^\n]*> \| null;/);
        // An operation the model does not have stops the script instead of leaving a hole.
        const without = { definitions: { ...csn.definitions, 'NightgateService.verifyPredicate': undefined } };
        expect(() => clientAnswerTypes(without)).toThrow('NightgateService.verifyPredicate: the model has no such operation with an answer');
    }, 60_000);

    it('no declaration file of the client packages types anything as `any`', () => {
        for (const file of ['src/sdk/client.d.ts', 'src/browser/index.d.ts', 'src/browser/providers.d.mts', 'src/txbuilder/index.d.ts']) {
            const code = read(file).split('\n').filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line)).map(line => line.split('//')[0].replace(/\/\*.*?\*\//g, ''));
            const typed = code.filter(line => /(:|<|\||=)\s*any\b|\bany\[\]|Record<string, any>/.test(line));
            expect(typed, file).toEqual([]);
        }
    });
});
