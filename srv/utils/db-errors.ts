/**
 * Database error recognition shared by the job store and the instance lease.
 * SPDX-License-Identifier: Apache-2.0
 */

/** A unique/primary-key conflict, as PostgreSQL, SQLite or CAP's db-service report it. */
export function isUniqueViolation(err: unknown): boolean {
    const anyErr = err as { code?: unknown; message?: unknown };
    if (anyErr?.code === '23505' || anyErr?.code === 'UNIQUE_CONSTRAINT_VIOLATION' || anyErr?.code === 'ENTITY_ALREADY_EXISTS') return true;
    return /UNIQUE constraint failed|duplicate key value|violates unique constraint/i
        .test(String(anyErr?.message ?? err));
}
