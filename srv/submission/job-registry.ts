/**
 * Registry of background job kinds, their processors and their finalizers.
 * A finalizer does the database writes that must follow a confirmed transaction.
 * SPDX-License-Identifier: Apache-2.0
 */
import type { BackgroundJob } from '#cds-models/midnight';
import { JOB_KIND_TRAITS, LIGHT_KIND, type JobKindTraits } from './job-kinds';
import { decrypt as decryptAtRest, getEncryptionKey } from '../utils/crypto';
import { jobCommandBinding } from '../utils/envelope-bindings';
import { ReconciliationEvidence } from './job-store';

const kindTraits = new Map<string, JobKindTraits>();

function isTraits(value: unknown): value is JobKindTraits {
    const t = value as JobKindTraits | null;
    return !!t && typeof t === 'object'
        && typeof t.heavy === 'boolean' && typeof t.workflowParent === 'boolean' && typeof t.identifierKeyed === 'boolean';
}

export function declareJobKind(kind: string, traits: JobKindTraits): void {
    if (!kind || !isTraits(traits)) throw new Error(`declareJobKind(${kind}): heavy, workflowParent and identifierKeyed must be booleans`);
    kindTraits.set(kind, { ...traits });
}

/** An unknown kind, for example a row of a removed kind, counts as light. */
export function jobKindTraits(kind: string): JobKindTraits {
    return kindTraits.get(kind) ?? LIGHT_KIND;
}

export function kindsWithTrait(trait: 'heavy' | 'workflowParent' | 'identifierKeyed' | 'serial' | 'sessionBound'): string[] {
    return [...kindTraits.entries()].filter(([, t]) => t[trait] === true).map(([k]) => k);
}

export function __workflowParentKindsForTests(): ReadonlySet<string> { return new Set(kindsWithTrait('workflowParent')); }

export type BackgroundJobProcessor = (command: unknown, row: BackgroundJob) => Promise<unknown>;

export type BackgroundJobReconciliationFinalizer = (
    command: unknown,
    row: BackgroundJob,
    evidence: ReconciliationEvidence
) => Promise<unknown>;

export const processors = new Map<string, BackgroundJobProcessor>();

const reconciliationFinalizers = new Map<string, BackgroundJobReconciliationFinalizer>();

export const processorKey = (kind: string, version: number): string => `${kind}\0${version}`;

export function registerBackgroundJobProcessor(kind: string, version: number, traits: JobKindTraits, processor: BackgroundJobProcessor): void {
    if (!kind || !Number.isInteger(version) || version < 1 || typeof processor !== 'function') {
        throw new Error('registerBackgroundJobProcessor: kind, positive version, traits and processor are required');
    }
    declareJobKind(kind, traits);
    processors.set(processorKey(kind, version), processor);
}

/** Declared kinds without a processor. The job runner refuses to start if there are any. */
export function undeclaredOrUnregisteredJobKinds(): string[] {
    const registered = new Set([...processors.keys()].map(k => k.split('\0')[0]));
    return Object.keys(JOB_KIND_TRAITS).filter(kind => !registered.has(kind));
}

/** Register the finalizer of one command. It must be safe to run more than once. */
export function registerBackgroundJobReconciliationFinalizer(
    kind: string,
    version: number,
    finalizer: BackgroundJobReconciliationFinalizer
): void {
    if (!kind || !Number.isInteger(version) || version < 1 || typeof finalizer !== 'function') {
        throw new Error('registerBackgroundJobReconciliationFinalizer: kind, positive version and finalizer are required');
    }
    reconciliationFinalizers.set(processorKey(kind, version), finalizer);
}

export async function executePersistedCommand(row: BackgroundJob): Promise<unknown> {
    const processor = processors.get(processorKey(row.kind, row.commandVersion!));
    if (!processor) throw new Error(`No background-job processor registered for '${row.kind}' v${row.commandVersion}`);
    const serialized = row.commandEncoding === 'aes-gcm-v1'
        ? decryptAtRest(row.command!, getEncryptionKey(), jobCommandBinding(String(row.ID)))
        : row.command!;
    return processor(JSON.parse(serialized), row);
}

/** Every path that confirms a job runs this, so no job succeeds without its finalizer's writes. */
export async function runReconciliationFinalizer(job: BackgroundJob, evidence: ReconciliationEvidence): Promise<unknown | undefined> {
    const finalizer = job.commandVersion
        ? reconciliationFinalizers.get(processorKey(job.kind, job.commandVersion))
        : undefined;
    if (!finalizer) return undefined;
    const serialized = job.commandEncoding === 'aes-gcm-v1'
        ? decryptAtRest(job.command!, getEncryptionKey(), jobCommandBinding(String(job.ID)))
        : job.command!;
    return finalizer(JSON.parse(serialized), job, evidence);
}
