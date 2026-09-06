// Bounded insertion-ordered cache with an eviction hook (worker-local, dependency-free).



export class BoundedCache<K, V> {
    private readonly map = new Map<K, V>();
    constructor(private readonly max: number, private readonly onEvict?: (key: K, value: V) => void) {}
    get(key: K): V | undefined {
        const v = this.map.get(key);
        if (v !== undefined) { this.map.delete(key); this.map.set(key, v); }
        return v;
    }
    set(key: K, value: V): void {
        this.map.delete(key);
        this.map.set(key, value);
        while (this.map.size > this.max) {
            const oldest = this.map.keys().next().value as K;
            const evicted = this.map.get(oldest) as V;
            this.map.delete(oldest);
            try { this.onEvict?.(oldest, evicted); } catch { /* eviction hooks are best effort */ }
        }
    }
    has(key: K): boolean { return this.map.has(key); }
    delete(key: K): boolean { return this.map.delete(key); }
    get size(): number { return this.map.size; }
    keys(): K[] { return [...this.map.keys()]; }
}
