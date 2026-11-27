/* Firestore wrapper that (a) counts the reads/writes/deletes this API performs
 * so the quota guard can see them, and (b) caches short-lived reads.
 *
 * Why the cache matters for the free tier
 * ---------------------------------------
 * Several routes in this API scan whole collections on every request
 * (`/api/ads/local/:id`, `/api/societies/verify`, ...). One popular page
 * refresh could cost dozens of document reads; Firestore's free band is 50,000
 * reads/day. A short TTL on those scans removes almost all of that traffic
 * without changing any response shape.
 *
 * Invalidation is per collection
 * ------------------------------
 * Every read captures the *collection's* version before it touches Firestore
 * and only caches its result while that version is unchanged. A write bumps
 * the version of the collection it touched, so:
 *   - an unrelated collection's cache survives writes elsewhere (a contest spin
 *     no longer throws away the cached society list),
 *   - a read that started before a write cannot repopulate a stale entry after
 *     the write commits,
 *   - a transaction invalidates only what it actually wrote.
 *
 * `get({ fresh: true })` bypasses the cache for that one read. It is reserved
 * for authorization-critical lookups (membership records), where a stale answer
 * would be a security problem. Ordinary reads must not pass it: it is the main
 * way the cache gets defeated.
 *
 * Reads inside a transaction are never cached, because correctness there
 * matters more than the read count (gift-code redemption depends on it).
 */
'use strict';

const DEFAULT_CACHE_TTL_MS = 60000;

function unwrapRef(ref) {
    if (ref && typeof ref._getRawQuery === 'function') return ref._getRawQuery();
    return ref && ref.ref ? ref.ref : ref;
}

function createDbLayer(rawDb, options = {}) {
    const ttlMs = Math.max(0, Number(options.ttlMs !== undefined ? options.ttlMs : DEFAULT_CACHE_TTL_MS) || 0);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const counters = options.counters || { reads: 0, writes: 0, deletes: 0 };
    const cache = new Map();
    const versions = new Map();
    const stats = { hits: 0, misses: 0, entries: () => cache.size };

    function versionOf(name) {
        return versions.get(name) || 0;
    }

    function cacheGet(key) {
        if (ttlMs === 0) return undefined;
        const entry = cache.get(key);
        if (!entry) { stats.misses += 1; return undefined; }
        if (entry.expires <= now()) { cache.delete(key); stats.misses += 1; return undefined; }
        stats.hits += 1;
        return entry.value;
    }

    function ttlFor(requested) {
        const value = Number(requested);
        if (Number.isFinite(value) && value >= 0) return value;
        return ttlMs;
    }

    /* Store a result only while the collection's version is unchanged, so a
     * write that happened while the read was in flight cannot be masked by a
     * stale cache entry. */
    function cacheWith(name, key, value, version, ttl) {
        if (ttl <= 0 || version !== versionOf(name)) return;
        // Keep the map from growing without bound on very long-lived servers.
        if (cache.size >= 1000) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, { value, expires: now() + ttl });
    }

    /* Drop everything cached for one collection. Called after a write so the
     * admin UI sees its own change immediately. */
    function invalidate(collectionName) {
        versions.set(collectionName, versionOf(collectionName) + 1);
        const docPrefix = `d:${collectionName}/`;
        const queryPrefix = `c:${collectionName}:`;
        for (const key of cache.keys()) {
            if (key.startsWith(docPrefix) || key.startsWith(queryPrefix)) cache.delete(key);
        }
    }

    function clearCache() {
        for (const name of versions.keys()) versions.set(name, versionOf(name) + 1);
        cache.clear();
    }

    function countRead(value) {
        const size = value && typeof value.size === 'number' ? value.size : 1;
        counters.reads += Math.max(1, size);
        return value;
    }

    /* Aggregate queries are billed per 1,000 index entries (minimum one read). */
    function billAggregate(count) {
        const documents = Number(count);
        counters.reads += Number.isFinite(documents) && documents > 0 ? Math.ceil(documents / 1000) : 1;
    }

    function docRef(name, id) {
        const rawRef = id === undefined || id === null
            ? rawDb.collection(name).doc()
            : rawDb.collection(name).doc(id);
        const key = `d:${name}/${rawRef.id}`;

        return {
            id: rawRef.id,
            path: rawRef.path,
            ref: rawRef,
            parent: rawRef.parent,
            async get(getOptions = {}) {
                const fresh = Boolean(getOptions && getOptions.fresh);
                const ttl = ttlFor(getOptions && getOptions.ttlMs);
                if (!fresh && ttl > 0) {
                    const cached = cacheGet(key);
                    if (cached) return cached;
                }
                const version = versionOf(name);
                const snapshot = countRead(await rawRef.get());
                if (!fresh) cacheWith(name, key, snapshot, version, ttl);
                return snapshot;
            },
            async set(value, setOptions) {
                counters.writes += 1;
                invalidate(name);
                try { return await rawRef.set(value, setOptions); }
                finally { invalidate(name); }
            },
            async update(value) {
                counters.writes += 1;
                invalidate(name);
                try { return await rawRef.update(value); }
                finally { invalidate(name); }
            },
            async delete() {
                counters.deletes += 1;
                invalidate(name);
                try { return await rawRef.delete(); }
                finally { invalidate(name); }
            }
        };
    }

    function buildRawQuery(name, descriptor) {
        let built = rawDb.collection(name);
        for (const filter of descriptor.filters) {
            built = built.where(filter.field, filter.operator, filter.value);
        }
        for (const order of descriptor.orderBy) {
            built = built.orderBy(order.field, order.direction);
        }
        if (descriptor.limit !== null && descriptor.limit !== undefined) {
            built = built.limit(descriptor.limit);
        }
        return built;
    }

    function query(name, descriptor) {
        return {
            // Lazily build the raw query only when a transaction reads it;
            // normal document operations must not create an extra collection ref.
            _getRawQuery() { return buildRawQuery(name, descriptor); },
            where(field, operator, value) {
                return query(name, {
                    ...descriptor,
                    filters: descriptor.filters.concat([{ field, operator, value }])
                });
            },
            orderBy(field, direction) {
                return query(name, {
                    ...descriptor,
                    orderBy: descriptor.orderBy.concat([{ field, direction: direction || 'asc' }])
                });
            },
            limit(count) {
                return query(name, { ...descriptor, limit: count });
            },
            async get(getOptions = {}) {
                const fresh = Boolean(getOptions && getOptions.fresh);
                const ttl = ttlFor(getOptions && getOptions.ttlMs);
                const cacheKey = `c:${name}:${JSON.stringify(descriptor)}`;
                if (!fresh && ttl > 0) {
                    const cached = cacheGet(cacheKey);
                    if (cached) return cached;
                }
                const version = versionOf(name);
                const snapshot = countRead(await buildRawQuery(name, descriptor).get());
                if (!fresh && ttl > 0) cacheWith(name, cacheKey, snapshot, version, ttl);
                return snapshot;
            },
            /* count()/sum() are billed per 1,000 matched index entries. Use them
             * where documents are read only to be counted. */
            async count() {
                const raw = buildRawQuery(name, descriptor);
                if (typeof raw.count !== 'function') {
                    // A backend without aggregate queries (the local JSON store
                    // in older shapes): fall back to a plain read.
                    const snapshot = await this.get({ fresh: true });
                    return Array.isArray(snapshot.docs) ? snapshot.docs.length : snapshot.size || 0;
                }
                const aggregate = await raw.count().get();
                const total = aggregate && aggregate.data ? Number(aggregate.data().count) || 0 : 0;
                billAggregate(total);
                return total;
            }
        };
    }

    function collection(name) {
        const base = query(name, { filters: [], orderBy: [], limit: null });
        return {
            ...base,
            id: name,
            doc(id) {
                return docRef(name, id);
            },
            async add(value) {
                counters.writes += 1;
                invalidate(name);
                try { return await rawDb.collection(name).add(value); }
                finally { invalidate(name); }
            }
        };
    }

    function batch() {
        const operations = [];
        return {
            set(ref, value, setOptions) {
                operations.push({ type: 'set', ref: unwrapRef(ref), value, setOptions });
                return this;
            },
            update(ref, value) {
                operations.push({ type: 'update', ref: unwrapRef(ref), value });
                return this;
            },
            delete(ref) {
                operations.push({ type: 'delete', ref: unwrapRef(ref) });
                return this;
            },
            async commit() {
                const raw = rawDb.batch();
                let writes = 0;
                let deletes = 0;
                const touched = new Set();
                for (const operation of operations) {
                    const collectionName = operation.ref && operation.ref.parent ? operation.ref.parent.id : null;
                    if (collectionName) touched.add(collectionName);
                    if (operation.type === 'set') {
                        raw.set(operation.ref, operation.value, operation.setOptions);
                        writes += 1;
                    } else if (operation.type === 'update') {
                        raw.update(operation.ref, operation.value);
                        writes += 1;
                    } else {
                        raw.delete(operation.ref);
                        deletes += 1;
                    }
                }
                const result = await raw.commit();
                counters.writes += writes;
                counters.deletes += deletes;
                // Invalidate only the collections this batch touched.
                for (const collectionName of touched) invalidate(collectionName);
                return result;
            }
        };
    }

    async function runTransaction(updateFunction) {
        try {
            return await rawDb.runTransaction(async transaction => {
                const touched = new Set();
                const wrapped = {
                    async get(ref) {
                        const snapshot = await transaction.get(unwrapRef(ref));
                        const size = snapshot && typeof snapshot.size === 'number' ? snapshot.size : 1;
                        counters.reads += Math.max(1, size);
                        return snapshot;
                    },
                    set(ref, value, setOptions) {
                        counters.writes += 1;
                        const raw = unwrapRef(ref);
                        if (raw && raw.parent) touched.add(raw.parent.id);
                        transaction.set(raw, value, setOptions);
                        return wrapped;
                    },
                    update(ref, value) {
                        counters.writes += 1;
                        const raw = unwrapRef(ref);
                        if (raw && raw.parent) touched.add(raw.parent.id);
                        transaction.update(raw, value);
                        return wrapped;
                    },
                    delete(ref) {
                        counters.deletes += 1;
                        const raw = unwrapRef(ref);
                        if (raw && raw.parent) touched.add(raw.parent.id);
                        transaction.delete(raw);
                        return wrapped;
                    }
                };
                try {
                    return await updateFunction(wrapped);
                } finally {
                    // A completed transaction has committed (or will commit) the
                    // collections it wrote; everything else stays cached.
                    for (const collectionName of touched) invalidate(collectionName);
                }
            });
        } catch (error) {
            // A failed/aborted transaction may have committed partially on the
            // emulator or local store; be conservative and drop the cache.
            clearCache();
            throw error;
        }
    }

    const db = {
        collection,
        batch,
        runTransaction
    };

    return {
        db,
        counters,
        stats,
        ttlMs,
        invalidate,
        clearCache
    };
}

module.exports = { createDbLayer, DEFAULT_CACHE_TTL_MS, unwrapRef };
