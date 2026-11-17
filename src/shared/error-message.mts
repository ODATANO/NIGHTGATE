/** The message of a thrown value. Objects without a `.message`, as some SDK errors are, become JSON. */
export function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (err == null) return String(err);
    if (typeof err === 'string') return err;
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    try { return JSON.stringify(err); }
    catch { return String(err); }
}
