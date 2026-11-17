// The batch runner with the segment mode of the server's config, or of the environment outside the server.
import {
    runBatchInScope as runBatch,
    type BatchCall,
    type BatchScopeOptions,
    type BatchScopeResult,
    type FoundBatchContract,
    type ScopedContracts
} from '../../src/shared/batch-call-scope.mjs';
import type { BatchOrderOptions } from '../../src/shared/batch-segment-order.mjs';
import { runtimeConfigEnum } from './runtime-config';

export { landedHeight, lastCallSegmentId } from '../../src/shared/batch-call-scope.mjs';
export type { BatchCall, BatchScopeResult, FoundBatchContract, LandedTx, ScopedContracts } from '../../src/shared/batch-call-scope.mjs';

/** Runs several circuit calls on one contract as one transaction, in call order unless `orderOpts.independentCalls` is set. */
export function runBatchInScope(
    contracts: ScopedContracts,
    providers: unknown,
    found: FoundBatchContract,
    calls: BatchCall[],
    contractAddress: string,
    orderOpts: BatchOrderOptions = {},
    scopeOpts: Pick<BatchScopeOptions, 'additionalCoinEncPublicKeyMappings'> = {}
): Promise<BatchScopeResult> {
    const segmentMode = runtimeConfigEnum<'observe' | 'rewrite'>('NIGHTGATE_BATCH_SEGMENT_MODE') ?? 'rewrite';
    return runBatch(contracts, providers, found, calls, contractAddress, orderOpts, { ...scopeOpts, segmentMode });
}
