// SPDX-License-Identifier: Apache-2.0
import { errorMessage } from './errors';

/** A row with this key exists already. A repeated write that already succeeded is not a real failure. */
export function isUniqueViolation(err: unknown): boolean {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    if (code === '23505' || code === 'UNIQUE_CONSTRAINT_VIOLATION' || code === 'ENTITY_ALREADY_EXISTS') return true;
    // PostgreSQL, SQLite and SAP HANA (301) texts.
    return /UNIQUE constraint failed|duplicate key value|violates unique constraint|unique constraint violated/i.test(errorMessage(err));
}
