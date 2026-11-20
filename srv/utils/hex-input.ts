// SPDX-License-Identifier: Apache-2.0
// Hex is stored lowercase without `0x`. This module brings what a caller compares with a stored value into that
// spelling: the operands of a read and the hex parameters of a function. The model marks the fields with `@nightgate.hex`.
import type cds from '@sap/cds';
import { bareHex } from './hex-patterns';

const MARK = '@nightgate.hex';
const COMPARISONS = new Set(['=', '==', '!=', '<>', '<', '<=', '>', '>=', 'in']);
const STRING_MATCHES = new Set(['contains', 'startswith', 'endswith']);
const BARE_HEX_RE = /^[0-9a-f]*$/;

/** The parts of a linked model definition this module reads. */
interface Field { [MARK]?: boolean; key?: boolean; _target?: Entity }
interface Operation { params?: Record<string, Field> }
interface Entity { elements?: Record<string, Field>; actions?: Record<string, Operation> }

type Segment = string | { id: string; where?: Token[] };
interface TokenObject {
    ref?: Segment[];
    val?: unknown;
    list?: Token[];
    xpr?: Token[];
    func?: string;
    args?: Token[];
    where?: Token[];
    expand?: Token[];
}
type Token = string | TokenObject;
interface Select { from?: TokenObject; where?: Token[]; columns?: Token[] }

class NotHex extends Error {
    constructor(field: string) { super(`${field} must be hex`); }
}

const nameOf = (segment: Segment): string => typeof segment === 'string' ? segment : segment.id;

function normalizeOperand(operand: Token | undefined, field: string): void {
    if (!operand || typeof operand === 'string') return;
    if (operand.list) {
        for (const item of operand.list) normalizeOperand(item, field);
        return;
    }
    if (typeof operand.val !== 'string') return;
    const bare = bareHex(operand.val);
    if (!BARE_HEX_RE.test(bare)) throw new NotHex(field);
    operand.val = bare;
}

/** The name of the hex field a path ends in, if it does. Filters on the steps of the path are normalized on the way. */
function hexFieldOf(entity: Entity, path: Segment[]): string | undefined {
    let current: Entity | undefined = entity;
    for (let i = 0; i < path.length; i++) {
        const segment = path[i];
        const field: Field | undefined = current?.elements?.[nameOf(segment)];
        if (!field) return undefined;
        if (typeof segment !== 'string' && segment.where && field._target) normalizeCondition(segment.where, field._target);
        if (i === path.length - 1) return field[MARK] ? nameOf(segment) : undefined;
        current = field._target;
    }
    return undefined;
}

function normalizeCondition(tokens: Token[], entity: Entity): void {
    tokens.forEach((token, i) => {
        if (typeof token === 'string') return;
        if (token.xpr) return normalizeCondition(token.xpr, entity);
        if (token.func) {
            const [subject, operand] = token.args ?? [];
            if (!STRING_MATCHES.has(token.func) || typeof subject !== 'object' || !subject.ref) return;
            const field = hexFieldOf(entity, subject.ref);
            if (field) normalizeOperand(operand, field);
            return;
        }
        const field = token.ref && hexFieldOf(entity, token.ref);
        if (!field) return;
        // The operand stands on the other side of the operator, left or right of the field.
        if (COMPARISONS.has(String(tokens[i + 1]))) normalizeOperand(tokens[i + 2], field);
        if (COMPARISONS.has(String(tokens[i - 1]))) normalizeOperand(tokens[i - 2], field);
    });
}

/** A key predicate is a condition, or one bare value when the entity has a single key. */
function normalizeKey(where: Token[], entity: Entity): void {
    const [only] = where;
    if (where.length !== 1 || typeof only !== 'object' || !('val' in only)) return normalizeCondition(where, entity);
    const keys = Object.entries(entity.elements ?? {}).filter(([, field]) => field.key);
    if (keys.length === 1 && keys[0][1][MARK]) normalizeOperand(only, keys[0][0]);
}

function normalizeFrom(path: Segment[], definitions: Record<string, Entity | undefined>): void {
    let entity: Entity | undefined;
    path.forEach((segment, i) => {
        entity = i === 0 ? definitions[nameOf(segment)] : entity?.elements?.[nameOf(segment)]?._target;
        if (entity && typeof segment !== 'string' && segment.where) normalizeKey(segment.where, entity);
    });
}

function normalizeExpands(columns: Token[] | undefined, entity: Entity): void {
    for (const column of columns ?? []) {
        if (typeof column === 'string' || !column.ref || !column.expand) continue;
        const expanded = entity.elements?.[nameOf(column.ref[0])]?._target;
        if (!expanded) continue;
        if (column.where) normalizeCondition(column.where, expanded);
        normalizeExpands(column.expand, expanded);
    }
}

/** Rewrites the hex operands of `select` in place. Throws `NotHex` for an operand that is not hex. */
export function normalizeHexOperands(select: Select, target: Entity | undefined, definitions: Record<string, Entity | undefined>): void {
    if (select.from?.ref) normalizeFrom(select.from.ref, definitions);
    if (!target) return;
    if (select.where) normalizeCondition(select.where, target);
    normalizeExpands(select.columns, target);
}

/** Rewrites the hex parameters in `data` in place. CAP has checked their format before. */
export function normalizeHexParams(data: unknown, operation: Operation | undefined): void {
    if (!operation?.params || !data || typeof data !== 'object') return;
    const values = data as Record<string, unknown>;
    for (const [name, param] of Object.entries(operation.params)) {
        if (param[MARK] && typeof values[name] === 'string') values[name] = bareHex(values[name]);
    }
}

/** Registers the normalization on a service. Call it before the service's own handlers, so they see the stored spelling. */
export function attachHexInput(srv: cds.ApplicationService): void {
    srv.before('*', (req) => {
        const target = req.target as unknown as Entity | undefined;
        const unbound = srv.actions as unknown as Record<string, Operation> | undefined;
        normalizeHexParams(req.data, (target?.actions ?? unbound)?.[req.event]);
        const select = (req.query as unknown as { SELECT?: Select } | undefined)?.SELECT;
        if (!select) return;
        try {
            normalizeHexOperands(select, target, srv.model.definitions as unknown as Record<string, Entity | undefined>);
        } catch (err) {
            if (err instanceof NotHex) return req.reject(400, err.message);
            throw err;
        }
    });
}
