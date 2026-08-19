import { formatErr, formatErrWithCauses } from '../../srv/utils/format-error';

describe('formatErr', () => {
    it('returns the message for Error instances', () => {
        expect(formatErr(new Error('boom'))).toBe('boom');
    });

    it('returns the string for string values', () => {
        expect(formatErr('plain string')).toBe('plain string');
    });

    it('returns "null" / "undefined" for nullish values', () => {
        expect(formatErr(null)).toBe('null');
        expect(formatErr(undefined)).toBe('undefined');
    });

    it('JSON-stringifies plain objects so they do not become [object Object]', () => {
        expect(formatErr({ code: 'E_FOO', detail: 'bar' })).toBe('{"code":"E_FOO","detail":"bar"}');
    });

    it('falls back to String() when JSON.stringify throws (e.g. circular refs)', () => {
        const circular: any = { name: 'cycle' };
        circular.self = circular;
        expect(formatErr(circular)).toBe('[object Object]');
    });
});

describe('formatErrWithCauses (worker RPC boundary)', () => {
    it('appends the nested cause chain so the node reject line survives the thread boundary', () => {
        // Live shape: (FiberFailure) SubmissionError > SubmissionError > RpcError 1010/196
        const inner = new Error('1010: Invalid Transaction: Custom error: 196');
        const mid = Object.assign(new Error('Transaction submission failed'), { cause: inner });
        const top = Object.assign(new Error('Transaction submission error'), { cause: mid });
        expect(formatErrWithCauses(top)).toBe(
            'Transaction submission error <- Transaction submission failed <- 1010: Invalid Transaction: Custom error: 196'
        );
    });

    it('is plain formatErr when there is no cause', () => {
        expect(formatErrWithCauses(new Error('boom'))).toBe('boom');
        expect(formatErrWithCauses('str')).toBe('str');
    });

    it('does not repeat identical messages and stops on cycles', () => {
        const a: any = new Error('same');
        const b: any = new Error('same');
        a.cause = b; b.cause = a;
        expect(formatErrWithCauses(a)).toBe('same');
    });

    it('reads the rendered [cause] lines when the cause is not a property chain (Effect FiberFailure)', () => {
        // FiberFailure keeps its Cause behind a symbol and only renders it via inspect.
        const wrapped: any = new Error('Transaction submission error');
        wrapped[Symbol.for('nodejs.util.inspect.custom')] = () =>
            '(FiberFailure) SubmissionError: Transaction submission error\n'
            + '    at file:///x/submissionService.js:31:279\n'
            + '  [cause]: SubmissionError: Transaction submission failed\n'
            + '      at file:///x/PolkadotNodeClient.js:80:22 {\n'
            + '    [cause]: TransactionInvalidError: Transaction is invalid and was rejected by the node\n'
            + '  }';
        expect(formatErrWithCauses(wrapped)).toBe(
            'Transaction submission error <- SubmissionError: Transaction submission failed <- TransactionInvalidError: Transaction is invalid and was rejected by the node'
        );
    });

    it('falls back to a bare Substrate reject line when nothing else is structured', () => {
        const wrapped: any = new Error('Transaction submission error');
        wrapped[Symbol.for('nodejs.util.inspect.custom')] = () =>
            'FiberFailure: Transaction submission error RPC 1010: Invalid Transaction: Custom error: 170';
        expect(formatErrWithCauses(wrapped)).toBe('Transaction submission error <- 1010: Invalid Transaction: Custom error: 170');
    });
});
