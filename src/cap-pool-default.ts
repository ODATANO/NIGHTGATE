/**
 * CAP's built-in connection pool (@cap-js/db-service 3.0.x) loses a pooled
 * connection whenever it dispenses one to a request that already timed out
 * (`generic-pool.js` `#dispense`, non-pending branch: neither loaned nor
 * returned). Under load the pool empties and every request fails with
 * "Pool resource could not be acquired". The `generic-pool` package (a
 * dependency of this plugin) does not have the defect, and CAP selects it via
 * `features.use_generic_pool`. The flag is read when db-service loads, so it
 * has to be set at plugin registration, before any db connect.
 *
 * Applied only when the host has not decided: an explicit `true`/`false` in
 * the host's config stays.
 */
export function applyPoolDefault(env: { features?: Record<string, unknown> }): boolean {
    const features = (env.features ??= {});
    if (features.use_generic_pool === undefined) {
        features.use_generic_pool = true;
        return true;
    }
    return false;
}
