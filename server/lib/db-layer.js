/* Firestore wrapper that (a) counts the reads/writes/deletes this API performs
 * so the quota guard can see them, and (b) caches short-lived reads.
 *
 * Why the cache matters for the free tier
 * ---------------------------------------
 * Several routes in this API scan whole collections on every request
 * (`/api/ads/local/:id`, `/api/admins`, `/api/societies/verify`,
 * `/api/contest/spin`, ...). One popular page refresh could cost dozens of
 * document reads; Firestore's free band is 50,000 reads/day. A 20 second TTL on
 * those scans removes almost all of that traffic without changing any response
 * shape, and every write made through this wrapper invalidates the collection it
 * touched, so the admin UI still sees its own changes immediately.
 *
 * Reads inside a transaction are never cached, because correctness there matters
 * more than the read count (gift-code redemption depends on it).
 */
'use strict';

const DEFAULT_CACHE_TTL_MS = 20000;

function unwrapRef(ref) {
    if (ref && typeof ref._getRawQuery === 'function') return ref._getRawQuery();
    return ref && ref.ref ? ref.ref : ref;
}

function createDbLayer(rawDb, options = {}) {
    const ttlMs = Math.max(0, Number(options.ttlMs !== undefined ? options.ttlMs : DEFAULT_CACHE_TTL_MS) || 0);
    const now = typeof options.now === 'function' ? options.now : () => Date.now();
    const counters = options.counters || { reads: 0, writes: 0, deletes: 0 };
    const cache = new Map();
    let generation = 0;
    const stats = { hits: 0, misses: 0, entries: () => cache.size };

    function cacheGet(key) {
        if (ttlMs === 0) return undefined;
        const entry = cache.get(key);
        if (!entry) { stats.misses += 1; return undefined; }
        if (entry.expires <= now()) { cache.delete(key); stats.misses += 1; return undefined; }
        stats.hits += 1;
        return entry.value;
    }

    function cacheSet(key, value, version) {
        if (version !== generation) return;
        if (ttlMs === 0) return;
        // Keep the map from growing without bound on very long-lived servers.
        if (cache.size >= 1000) {
            const oldest = cache.keys().next();
            if (!oldest.done) cache.delete(oldest.value);
        }
        cache.set(key, { value, expires: now() + ttlMs });
    }

    function invalidate(collectionName) {
        generation += 1;
        const docPrefix = `d:${collectionName}/`;
        const queryPrefix = `c:${collectionName}:`;
        for (const key of cache.keys()) {
            if (key.startsWith(docPrefix) || key.startsWith(queryPrefix)) cache.delete(key);
        }
    }

    function clearCache() {
        generation += 1;
        cache.clear();
    }

    function countRead(value) {
        const size = value && typeof value.size === 'number' ? value.size : 1;
        counters.reads += Math.max(1, size);
        return value;
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
                if (!fresh) {
                    const cached = cacheGet(key);
                    if (cached) return cached;
                }
                const version = generation;
                const snapshot = countRead(await rawRef.get());
                if (!fresh) cacheSet(key, snapshot, version);
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
                const cacheKey = `c:${name}:${JSON.stringify(descriptor)}`;
                if (!fresh) {
                    const cached = cacheGet(cacheKey);
                    if (cached) return cached;
                }
                const version = generation;
                const snapshot = countRead(await buildRawQuery(name, descriptor).get());
                if (!fresh) cacheSet(cacheKey, snapshot, version);
                return snapshot;
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
                for (const operation of operations) {
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
                clearCache();
                return result;
            }
        };
    }

    async function runTransaction(updateFunction) {
        try { return await rawDb.runTransaction(async transaction => {
            const wrapped = {
                async get(ref) {
                    const snapshot = await transaction.get(unwrapRef(ref));
                    const size = snapshot && typeof snapshot.size === 'number' ? snapshot.size : 1;
                    counters.reads += Math.max(1, size);
                    return snapshot;
                },
                set(ref, value, setOptions) {
                    counters.writes += 1;
                    transaction.set(unwrapRef(ref), value, setOptions);
                    return wrapped;
                },
                update(ref, value) {
                    counters.writes += 1;
                    transaction.update(unwrapRef(ref), value);
                    return wrapped;
                },
                delete(ref) {
                    counters.deletes += 1;
                    transaction.delete(unwrapRef(ref));
                    return wrapped;
                }
            };
            try {
                return await updateFunction(wrapped);
            } finally {
                clearCache();
            }
        }); } finally { clearCache(); }
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
