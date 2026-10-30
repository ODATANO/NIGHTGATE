/* eslint-disable no-console -- docker's captured output is this process's only channel to the operator. */
// Checks that NIGHTGATE works, not just that the port answers. The plugin keeps CAP alive while NIGHTGATE is offline.
// `getReadiness()` answers 503 in that case. Any status but 2xx, including 401 and 404, counts as unhealthy.

const PORT = process.env.PORT || '4004';
// 127.0.0.1, not localhost: where that name resolves to ::1 first and the
// server listens on IPv4, the probe stalls until its own timeout and reports
// a healthy container as sick.
const URL = `http://127.0.0.1:${PORT}/odata/v4/midnight-indexer/getReadiness()`;

async function main() {
    const res = await fetch(URL, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 404) {
        console.error(`healthcheck: getReadiness() answered ${res.status}; readiness cannot be verified.`);
        process.exit(1);
    }
    process.exit(res.ok ? 0 : 1);
}

main().catch(err => {
    console.error(`healthcheck: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
});
