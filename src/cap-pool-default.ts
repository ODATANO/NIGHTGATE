/**
 * Makes CAP use the `generic-pool` package for database connections.
 * CAP's built-in pool loses a connection each time a request times out while waiting, until no connection is left.
 * CAP reads this flag when its database layer loads, so it is set when the plugin loads.
 * A value the host app sets itself is kept.
 */
export function applyPoolDefault(env: { features?: Record<string, unknown> }): boolean {
    const features = (env.features ??= {});
    if (features.use_generic_pool === undefined) {
        features.use_generic_pool = true;
        return true;
    }
    return false;
}
