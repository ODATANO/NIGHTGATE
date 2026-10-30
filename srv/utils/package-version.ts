/** The running NIGHTGATE version from package.json; 'unknown' in a package layout without it. No imports. */
export function packageVersion(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return String((require('../../package.json') as { version?: string }).version ?? 'unknown');
    } catch {
        return 'unknown';
    }
}
