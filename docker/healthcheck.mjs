/* eslint-disable no-console -- a healthcheck's only channel to the operator is
   docker's captured output; there is no logger in this process. */
/**
 * Container healthcheck: does NIGHTGATE work, not merely does the port answer.
 *
 * The plugin deliberately keeps its CAP host alive when Nightgate itself is
 * offline (an un-migrated database, a submission pipeline that did not start),
 * so probing `/` reports such a container as healthy while nothing works.
 * `getReadiness()` is anonymous at the model level and answers 503 in exactly
 * those cases. Anything but a 2xx, including 401 and 404, is a failure: a
 * probe that cannot see readiness must not claim the container is fine.
 */

const PORT = process.env.PORT || '4004';
// 127.0.0.1, not localhost: where that name resolves to ::1 first and the
// server listens on IPv4, the probe stalls until its own timeout and reports
// a healthy container as sick.
const URL = `http://127.0.0.1:${PORT}/api/v1/indexer/getReadiness()`;

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
