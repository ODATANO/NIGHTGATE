#!/usr/bin/env node
// Writes the answer types of the client's read methods into src/sdk/client.d.ts, from the server's model.
// `npm run client:types` refreshes the block between the answer-types markers.
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const START = '// answer-types:start';
export const END = '// answer-types:end';

/** The server operations whose answer a client method hands out unchanged, by service. `Entity/name` is a bound function. */
export const ANSWERS = {
    NightgateService: [
        'Blocks/ledgerParametersAt', 'getGrantUsage',
        'verifyAttestation', 'verifyPredicate', 'verifyDisclosure', 'verifyPredicateAttestation', 'verifyDocument', 'deriveTokenType',
        'prepareDocumentProof', 'prepareMembershipSet',
        'connectWallet', 'connectWalletForSigning', 'disconnectWallet', 'deriveWalletInfo', 'getWalletBalance', 'getWalletSyncProgress'
    ],
    NightgateIndexerService: ['getHealth']
};

// A 64-bit integer and a decimal arrive as a JSON number, or as text where a number would lose digits.
const SCALARS = {
    'cds.Boolean': 'boolean',
    'cds.String': 'string', 'cds.LargeString': 'string', 'cds.UUID': 'string',
    'cds.Timestamp': 'string', 'cds.DateTime': 'string', 'cds.Date': 'string',
    'cds.Integer': 'number', 'cds.Int16': 'number', 'cds.Int32': 'number', 'cds.UInt8': 'number', 'cds.Double': 'number',
    'cds.Integer64': 'number | string', 'cds.Decimal': 'number | string',
    'cds.Map': 'Record<string, unknown>'
};

const answerName = (operation) => operation[0].toUpperCase() + operation.slice(1) + 'Answer';

/** The TypeScript declarations of the answers, as the lines between the markers. */
export function clientAnswerTypes(csn) {
    const structs = new Map();

    const literals = (enumeration) => Object.entries(enumeration).map(([key, entry]) => JSON.stringify(entry?.val ?? key)).join(' | ');
    // OData has no null list, so only a list's items can be null.
    const isList = (type) => Boolean(type.items ?? csn.definitions[type.type]?.items);
    const fields = (elements, where) => Object.entries(elements).map(([name, element]) => {
        const type = typeOf(element, `${where}.${name}`);
        return `${name}: ${element.notNull || isList(element) ? type : `${type} | null`};`;
    });
    function typeOf(type, where) {
        if (type.items) return `Array<${typeOf(type.items, where)}${type.items.notNull ? '' : ' | null'}>`;
        if (type.elements) return `{ ${fields(type.elements, where).join(' ')} }`;
        if (type.enum) return literals(type.enum);
        const named = csn.definitions[type.type];
        if (named?.elements) {
            const name = type.type.split('.').pop();
            if (!structs.has(name)) {
                structs.set(name, null);
                structs.set(name, fields(named.elements, name));
            }
            return name;
        }
        if (named) return typeOf(named, where);
        const scalar = SCALARS[type.type];
        if (!scalar) throw new Error(`${where}: no TypeScript type for '${type.type}'`);
        return scalar;
    }

    const answers = [];
    for (const [service, operations] of Object.entries(ANSWERS)) {
        for (const path of operations) {
            const [entity, operation] = path.includes('/') ? path.split('/') : [null, path];
            const definition = entity ? csn.definitions[`${service}.${entity}`]?.actions?.[operation] : csn.definitions[`${service}.${operation}`];
            if (!definition?.returns) throw new Error(`${service}.${path}: the model has no such operation with an answer`);
            const { returns } = definition;
            const name = answerName(operation);
            answers.push(returns.elements && !returns.type
                ? [`/** The answer of \`${operation}\`. */`, `export interface ${name} {`, ...fields(returns.elements, operation).map(line => `    ${line}`), '}']
                : [`/** The answer of \`${operation}\`. */`, `export type ${name} = ${typeOf(returns, operation)};`]);
        }
    }
    const shared = [...structs.entries()].map(([name, lines]) => [`export interface ${name} {`, ...lines.map(line => `    ${line}`), '}']);
    return [
        '// Written by `npm run client:types` from the server\'s model. A field or a list item the model does not mark `not null` can be null.',
        ...[...shared, ...answers].flatMap(block => ['', ...block])
    ];
}

/** The server's model as the compiler reads it. */
export async function loadModel() {
    const cds = require('@sap/cds');
    return cds.load([path.join(root, 'db'), path.join(root, 'srv')]);
}

/** `text` with the block between the markers replaced by `lines`. */
export function withAnswerTypes(text, lines) {
    const from = text.indexOf(START);
    const to = text.indexOf(END);
    if (from < 0 || to < 0) throw new Error('src/sdk/client.d.ts: answer-types markers not found');
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    return text.slice(0, from) + START + eol + lines.join(eol) + eol + text.slice(to);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const lines = clientAnswerTypes(await loadModel());
    if (process.argv.includes('--write')) {
        const file = path.join(root, 'src/sdk/client.d.ts');
        writeFileSync(file, withAnswerTypes(readFileSync(file, 'utf8'), lines));
        console.log(`src/sdk/client.d.ts: ${Object.values(ANSWERS).flat().length} answer types written`);
    } else {
        process.stdout.write(lines.join('\n') + '\n');
    }
}
