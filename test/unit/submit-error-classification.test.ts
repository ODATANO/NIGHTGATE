/**
 * The one submit-failure classifier (srv/midnight/submit-error-classification.ts):
 * every code of the closed set from a representative SDK-shaped error, the
 * carried code winning over the text, and the dust-guard view of it.
 */
import { describe, it, expect } from 'vitest';
import { classifySubmitFailure, isPreMempoolFailure, parseBatchCallStages, causeMessages, SponsorRefusalError } from '../../srv/midnight/submit-error-classification';
import { WorkerSubmitError, carriedSubmitFailure, SUBMIT_FAILURE_CODES } from '../../srv/midnight/wallet-worker-protocol';
import { BatchCausalityError } from '../../srv/midnight/batch-segment-order';

/** The live SDK shape: generic wrappers on top, the node's line in the innermost cause. */
function sdkWrapped(inner: string): Error {
    const node = new Error(inner);
    const submission = new Error('Transaction submission failed', { cause: node });
    submission.name = 'SubmissionError';
    const fiber = new Error('Transaction submission error', { cause: submission });
    fiber.name = '(FiberFailure) SubmissionError';
    return fiber;
}

describe('landed-not-applied carries the block height', () => {
    it('takes the height from the worker error so the main thread has a rollback coordinate', () => {
        const err: any = new Error('sponsored transaction 00ab is in block 2415919 but its contract call did NOT apply');
        err.name = 'SponsoredCallNotAppliedError';
        err.blockHeight = 2415919;
        expect(classifySubmitFailure(err)).toMatchObject({ code: 'landed-not-applied', retryable: false, blockHeight: 2415919 });
        const bare: any = new Error('call did NOT apply');
        bare.name = 'SponsoredCallNotAppliedError';
        expect(classifySubmitFailure(bare)).toEqual({ code: 'landed-not-applied', retryable: false });
    });
});

describe('classifySubmitFailure', () => {
    it('a carried classification wins over the text', () => {
        const err = new WorkerSubmitError({ name: 'Error', message: '1010: Invalid Transaction: Custom error: 170', code: 'policy', retryable: false });
        expect(classifySubmitFailure(err)).toEqual({ code: 'policy', retryable: false, ledgerCode: undefined, calls: undefined });
        expect(carriedSubmitFailure(new Error('x'))).toBeNull();
        expect(carriedSubmitFailure({ code: 'not-a-code' })).toBeNull();
    });

    it('causality: our own error keeps its calls, the SDK-wrapped text is parsed back', () => {
        const calls = [{ name: 'attest', segId: 1158, stages: 'f:6.04G' }, { name: 'anchorContentRoot', segId: 1159, stages: 'g:5.3G' }];
        const own = new BatchCausalityError("batch [attest+anchorContentRoot] violates the ledger's causality constraint: x. Stages in apply order: attest=1158[f:6.04G] anchorContentRoot=1159[g:5.3G]", calls);
        const wrapped = new Error("Unexpected error submitting scoped transaction 'batch': " + own.message, { cause: own });
        expect(classifySubmitFailure(wrapped)).toEqual({ code: 'causality', retryable: false, calls });
        const textOnly = new Error("Unexpected error submitting scoped transaction 'batch': " + own.message);
        expect(classifySubmitFailure(textOnly)).toEqual({ code: 'causality', retryable: false, calls });
        expect(parseBatchCallStages('nothing here')).toEqual([]);
    });

    it('ambiguous: the watch timeout, by name and by text', () => {
        const named = new Error('submit watch timed out after 60000ms without a Finalized status');
        named.name = 'SubmitWatchTimeoutError';
        expect(classifySubmitFailure(named).code).toBe('ambiguous');
        expect(classifySubmitFailure(new Error('submit watch timed out after 60000ms without a Finalized status'))).toEqual({ code: 'ambiguous', retryable: false });
    });

    it('landed-not-applied: the sponsored and the bound flavour', () => {
        const sponsored = new Error('sponsored transaction 00ab is in block 1 but its contract call did NOT apply (ledger result PARTIAL_SUCCESS)');
        sponsored.name = 'SponsoredCallNotAppliedError';
        expect(classifySubmitFailure(sponsored).code).toBe('landed-not-applied');
        const bound = new Error('TxFailedError: transaction 00ab is in block 2 but did not apply (ledger result FAILURE)');
        bound.name = 'TxFailedError';
        expect(classifySubmitFailure(bound).code).toBe('landed-not-applied');
    });

    it('policy: the refusal class and its text', () => {
        expect(classifySubmitFailure(new SponsorRefusalError("refusing to sponsor: circuit 'x' is not sponsorable"))).toEqual({ code: 'policy', retryable: false });
        expect(classifySubmitFailure(new Error('refusing to sponsor: transaction carries a guaranteedUnshieldedOffer'))).toEqual({ code: 'policy', retryable: false });
    });

    it('pre-mempool-reject: the intent nack and the node lines, with the ledger code', () => {
        expect(classifySubmitFailure(new Error('submit-intent rejected by the main thread: db down'))).toEqual({ code: 'pre-mempool-reject', ledgerCode: 'intent-rejected', retryable: false });
        expect(classifySubmitFailure(sdkWrapped('1010: Invalid Transaction: Custom error: 188'))).toEqual({ code: 'pre-mempool-reject', ledgerCode: '1010/188', retryable: false });
        expect(classifySubmitFailure(new Error('Substrate error: invalid transaction'))).toEqual({ code: 'pre-mempool-reject', ledgerCode: '1010', retryable: false });
        // The priority values are arbitrary numbers, never a 1010 code.
        expect(classifySubmitFailure(new Error('1014: Priority is too low: (1010 vs 2000)'))).toEqual({ code: 'pre-mempool-reject', ledgerCode: '1014', retryable: false });
        expect(classifySubmitFailure(new Error('1016: Immediately Dropped'))).toEqual({ code: 'pre-mempool-reject', ledgerCode: '1016', retryable: true });
    });

    it('dust-race: coded 170/196, the SDK proof error and a bare pool Invalid', () => {
        expect(classifySubmitFailure(sdkWrapped('1010: Invalid Transaction: Custom error: 196'))).toEqual({ code: 'dust-race', ledgerCode: '1010/196', retryable: true });
        expect(classifySubmitFailure(new Error('submit failed: 1010/170'))).toEqual({ code: 'dust-race', ledgerCode: '1010/170', retryable: true });
        expect(classifySubmitFailure(new Error('InvalidDustSpendProof'))).toEqual({ code: 'dust-race', ledgerCode: '1010/170', retryable: true });
        expect(classifySubmitFailure(sdkWrapped('TransactionInvalidError: Transaction is invalid and was rejected by the node'))).toEqual({ code: 'dust-race', ledgerCode: 'pool-invalid', retryable: true });
        // Digit boundary: 1700 is not a code.
        expect(classifySubmitFailure(new Error('1010: Invalid Transaction: Custom error: 1700'))).toEqual({ code: 'pre-mempool-reject', ledgerCode: '1010/1700', retryable: false });
    });

    it('transport: socket failures, the client closing socket, an RPC timeout; never a stack frame', () => {
        expect(classifySubmitFailure(new Error('connect ECONNRESET 10.0.0.1:9944'))).toEqual({ code: 'transport', retryable: true });
        expect(classifySubmitFailure(new Error('disconnected from wss://x: 1000:: Normal Closure'))).toEqual({ code: 'transport', retryable: true });
        expect(classifySubmitFailure(new Error("submit request died on the client's own closing socket (SDK disconnect lag)"))).toEqual({ code: 'transport', ledgerCode: 'closing-socket', retryable: true });
    });

    it('a wait that ended without a reply is ambiguous, never transport: the send may have landed', () => {
        // An RPC or submit timeout after the send: a resend would duplicate a
        // landed transaction (1013) and a rebuild would double-spend.
        expect(classifySubmitFailure(new Error("wallet-worker rpc 'transferNight' timed out after 1000ms"))).toEqual({ code: 'ambiguous', ledgerCode: 'no-reply', retryable: false });
        expect(classifySubmitFailure(new Error('TimeoutError: no response from ws://relay within 30000ms'))).toEqual({ code: 'ambiguous', ledgerCode: 'no-reply', retryable: false });
        // a connect timeout is a failed connection: nothing was sent
        expect(classifySubmitFailure(new Error('connect ETIMEDOUT 10.0.0.1:9944'))).toEqual({ code: 'transport', retryable: true });
        const framed = new Error('boom');
        framed.stack = 'Error: boom\n    at submit (/app/node_modules/wallet.js:1010:27)';
        expect(classifySubmitFailure(framed)).toEqual({ code: 'internal', retryable: false });
    });

    it('internal for anything else; the closed set is what the protocol lists', () => {
        expect(classifySubmitFailure(new Error('finalized-tx round-trip FAILED at deserialize'))).toEqual({ code: 'internal', retryable: false });
        expect(classifySubmitFailure(undefined)).toEqual({ code: 'internal', retryable: false });
        expect(SUBMIT_FAILURE_CODES).toHaveLength(8);
    });

    it('isPreMempoolFailure: the dust guard restores on node rejects and coded races only', () => {
        expect(isPreMempoolFailure({ code: 'pre-mempool-reject', ledgerCode: '1010/188', retryable: false })).toBe(true);
        expect(isPreMempoolFailure({ code: 'pre-mempool-reject', ledgerCode: '1016', retryable: true })).toBe(true);
        expect(isPreMempoolFailure({ code: 'pre-mempool-reject', ledgerCode: 'intent-rejected', retryable: false })).toBe(false);
        expect(isPreMempoolFailure({ code: 'dust-race', ledgerCode: '1010/196', retryable: true })).toBe(true);
        expect(isPreMempoolFailure({ code: 'dust-race', ledgerCode: 'pool-invalid', retryable: true })).toBe(false);
        for (const code of ['transport', 'ambiguous', 'landed-not-applied', 'policy', 'causality', 'internal'] as const) {
            expect(isPreMempoolFailure({ code, retryable: false }), code).toBe(false);
        }
    });

    it('causeMessages walks the cause chain outermost first, bounded and cycle-safe', () => {
        expect(causeMessages(sdkWrapped('1010: Invalid Transaction: Custom error: 196'))).toEqual(['Transaction submission failed', '1010: Invalid Transaction: Custom error: 196']);
        const loop: any = new Error('a'); loop.cause = loop;
        expect(causeMessages(loop)).toEqual([]);
    });
});
