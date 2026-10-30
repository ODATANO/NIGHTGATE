// Makes CAP use `generic-pool` for database connections, unless the host app set the flag itself.
// CAP's built-in pool loses a connection each time a request times out while waiting for one.
export function applyPoolDefault(env: { features?: Record<string, unknown> }): boolean {
    const features = (env.features ??= {});
    if (features.use_generic_pool === undefined) {
        features.use_generic_pool = true;
        return true;
    }
    return false;
}
