/* A small, dependency-free stand-in for Firestore, backed by one JSON file.
 *
 * Why: the MacBook copy of this API must keep serving even when Firebase's
 * Firestore allowance is exhausted (Spark shuts the product off for the rest of
 * the day) or when you simply want to test with no Firebase project at all.
 * With DATA_BACKEND=local the entire server runs on this store and performs
 * zero Firebase operations.
 *
 * It implements the slice of the Admin SDK this codebase actually uses:
 *
 *   db.collection(name).doc(id).get()/set()/update()/delete()
 *   db.collection(name).doc()                     (generates an id)
 *   db.collection(name).add(value)
 *   db.collection(name).where(...).orderBy(...).limit(...).get()
 *   db.collection(name).get()
 *   db.batch().set()/update()/delete().commit()
 *   db.runTransaction(tx => ...)                  (serialised, rolled back on throw)
 *   FieldValue.serverTimestamp() / FieldValue.delete()
 *
 * Timestamps are stored as ISO-8601 strings, which sort correctly and survive
 * the JSON round trip. This is a development/single-machine store: it is written
 * synchronously and holds no locks, so run one copy of the server per file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SERVER_TIMESTAMP = '__owlServerTimestamp';
const DELETE_FIELD = '__owlDeleteField';
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function createFieldValue() {
    return {
        serverTimestamp: () => ({ [SERVER_TIMESTAMP]: true }),
        delete: () => ({ [DELETE_FIELD]: true })
    };
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}

function generateId() {
    const bytes = crypto.randomBytes(20);
    let id = '';
    for (let i = 0; i < bytes.length; i++) id += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
    return id;
}

function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

/* Replace Date objects and serverTimestamp sentinels with ISO strings, and drop
 * FieldValue.delete() markers (handled separately by update()). */
function resolveValue(value, clock) {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map(item => resolveValue(item, clock));
    if (isPlainObject(value)) {
        if (value[SERVER_TIMESTAMP]) return clock().toISOString();
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry && isPlainObject(entry) && entry[DELETE_FIELD]) continue;
            const resolved = resolveValue(entry, clock);
            if (resolved !== undefined) out[key] = resolved;
        }
        return out;
    }
    return value;
}

function fieldValue(data, field) {
    if (!field) return undefined;
    const parts = String(field).split('.');
    let current = data;
    for (const part of parts) {
        if (current === null || current === undefined) return undefined;
        current = current[part];
    }
    return current;
}

function compareValues(left, right) {
    if (left === right) return 0;
    if (left === undefined || left === null) return -1;
    if (right === undefined || right === null) return 1;
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function matchesFilter(data, filter) {
    // `FieldPath.documentId()` shows up as '__name__'; real Firestore supports
    // it, and the API uses it for exact document-id lookups.
    const actual = filter.field === '__name__' ? data.__id : fieldValue(data, filter.field);
    const expected = filter.value instanceof Date ? filter.value.toISOString() : filter.value;
    switch (filter.operator) {
        case '==': return actual === expected;
        case '!=': return actual !== expected;
        case '<': return actual !== undefined && actual !== null && actual < expected;
        case '<=': return actual !== undefined && actual !== null && actual <= expected;
        case '>': return actual !== undefined && actual !== null && actual > expected;
        case '>=': return actual !== undefined && actual !== null && actual >= expected;
        case 'in': return Array.isArray(expected) && expected.includes(actual);
        case 'not-in': return Array.isArray(expected) && !expected.includes(actual);
        case 'array-contains': return Array.isArray(actual) && actual.includes(expected);
        case 'array-contains-any': return Array.isArray(actual) && Array.isArray(expected) &&
            expected.some(candidate => actual.includes(candidate));
        default:
            throw new Error(`Unsupported where() operator: ${filter.operator}`);
    }
}

function createLocalStore(options = {}) {
    const file = options.file || path.join(process.cwd(), '.local-data', 'db.json');
    const clock = typeof options.now === 'function' ? options.now : () => new Date();
    const logger = options.logger || console;
    const store = { collections: {} };
    let queue = Promise.resolve();

    load();

    function load() {
        try {
            if (!fs.existsSync(file)) return;
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            const collections = parsed && parsed.collections ? parsed.collections : parsed;
            if (!collections || typeof collections !== 'object') throw new Error('expected an object of collections');
            for (const [name, docs] of Object.entries(collections)) {
                if (docs && typeof docs === 'object') store.collections[name] = docs;
            }
        } catch (error) {
            // Never start on a corrupt file: silently dropping it would look like data loss.
            throw new Error(`Local database at ${file} could not be read (${error.message}). ` +
                'Fix or move the file, or point LOCAL_DB_FILE at a different path.');
        }
    }

    function persist() {
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify({
                version: 1,
                savedAt: clock().toISOString(),
                collections: store.collections
            }, null, 2));
            fs.renameSync(tmp, file);
        } catch (error) {
            if (logger && typeof logger.error === 'function') {
                logger.error('[local-store] Could not write', file, '-', error.message);
            }
            throw error;
        }
    }

    // All mutations share one queue. A failed transaction/batch cannot roll
    // back an unrelated write that interleaved while its callback awaited.
    function mutate(callback) {
        const run = queue.then(async () => {
            const backup = clone(store.collections);
            try {
                const result = await callback();
                persist();
                return result;
            } catch (error) {
                store.collections = backup;
                throw error;
            }
        });
        queue = run.then(() => undefined, () => undefined);
        return run;
    }

    function validateKey(value) {
        if (['__proto__', 'constructor', 'prototype'].includes(String(value))) throw new Error('Unsupported local document key');
    }

    function docsOf(name) {
        validateKey(name);
        if (!store.collections[name]) store.collections[name] = {};
        return store.collections[name];
    }

    function readDoc(name, id) {
        const docs = store.collections[name];
        return docs ? docs[id] : undefined;
    }

    function setData(name, id, value, merge) {
        const docs = docsOf(name);
        const clean = resolveValue(value || {}, clock);
        docs[id] = merge && docs[id] ? { ...docs[id], ...clean } : clean;
    }

    function updateData(name, id, value) {
        const docs = docsOf(name);
        if (!docs[id]) {
            const error = new Error(`No document to update: ${name}/${id}`);
            error.code = 'not-found';
            throw error;
        }
        for (const [key, raw] of Object.entries(value || {})) {
            if (raw && isPlainObject(raw) && raw[DELETE_FIELD]) {
                delete docs[id][key];
                continue;
            }
            docs[id][key] = resolveValue(raw, clock);
        }
    }

    function deleteData(name, id) {
        const docs = store.collections[name];
        if (docs) delete docs[id];
    }

    function docSnapshot(name, id) {
        const data = clone(readDoc(name, id));
        return {
            id,
            exists: data !== undefined,
            ref: docRef(name, id),
            data: () => (data === undefined ? undefined : clone(data)),
            get: field => (data === undefined ? undefined : fieldValue(data, field))
        };
    }

    function querySnapshot(name, entries) {
        const docs = entries.map(entry => docSnapshot(name, entry.id));
        return {
            docs,
            size: docs.length,
            empty: docs.length === 0,
            forEach(callback, thisArg) { docs.forEach(callback, thisArg); }
        };
    }

    function runQuery(name, descriptor) {
        const docs = store.collections[name] || {};
        let entries = Object.entries(docs).map(([id, data]) => ({ id, data, __id: id }));
        if (descriptor.filters.length) {
            entries = entries.filter(entry => descriptor.filters.every(filter => matchesFilter(entry.data, filter)));
        }
        if (descriptor.orderBy.length) {
            entries = entries.slice().sort((left, right) => {
                for (const order of descriptor.orderBy) {
                    const direction = order.direction === 'desc' ? -1 : 1;
                    const compared = compareValues(fieldValue(left.data, order.field), fieldValue(right.data, order.field));
                    if (compared !== 0) return compared * direction;
                }
                return 0;
            });
        }
        if (descriptor.limit !== null && descriptor.limit !== undefined) {
            entries = entries.slice(0, Math.max(0, Number(descriptor.limit) || 0));
        }
        return querySnapshot(name, entries);
    }

    function query(name, descriptor) {
        return {
            __localQuery: { name, descriptor },
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
            /* Firestore's aggregate API: `count()` costs about one read per
             * thousand documents instead of one read per document. The local
             * store answers from memory; the read is reported by the db layer. */
            count() {
                return {
                    async get() {
                        await queue;
                        return { data: () => ({ count: runQuery(name, descriptor).size }) };
                    }
                };
            },
            async get() {
                await queue;
                return runQuery(name, descriptor);
            }
        };
    }

    function docRef(name, id) {
        const docId = id === undefined || id === null || id === '' ? generateId() : String(id);
        validateKey(docId);
        return {
            id: docId,
            path: `${name}/${docId}`,
            parent: { id: name },
            async get() {
                await queue;
                return docSnapshot(name, docId);
            },
            set(value, setOptions) {
                return mutate(() => setData(name, docId, value, setOptions && setOptions.merge));
            },
            update(value) {
                return mutate(() => updateData(name, docId, value));
            },
            delete() {
                return mutate(() => deleteData(name, docId));
            }
        };
    }

    function collection(name) {
        validateKey(name);
        const base = query(name, { filters: [], orderBy: [], limit: null });
        return {
            ...base,
            id: name,
            doc(id) {
                return docRef(name, id);
            },
            async add(value) {
                const reference = docRef(name);
                await mutate(() => setData(name, reference.id, value, false));
                return reference;
            }
        };
    }

    function batch() {
        const operations = [];
        return {
            set(ref, value, setOptions) {
                operations.push({ type: 'set', ref, value, setOptions });
                return this;
            },
            update(ref, value) {
                operations.push({ type: 'update', ref, value });
                return this;
            },
            delete(ref) {
                operations.push({ type: 'delete', ref });
                return this;
            },
            commit() {
                return mutate(() => {
                for (const operation of operations) {
                    if (operation.type === 'set') setData(operation.ref.parent.id, operation.ref.id, operation.value, operation.setOptions && operation.setOptions.merge);
                    else if (operation.type === 'update') updateData(operation.ref.parent.id, operation.ref.id, operation.value);
                    else deleteData(operation.ref.parent.id, operation.ref.id);
                }
                });
            }
        };
    }

    /* Serialised like a real transaction. Reads see writes made earlier in the
     * same callback, and a thrown error restores the previous state, which is
     * what makes gift-code redemption and contest spins behave correctly. */
    function runTransaction(updateFunction) {
        return mutate(async () => {
            const transaction = {
                get(ref) {
                    if (ref && ref.__localQuery) {
                        return Promise.resolve(runQuery(ref.__localQuery.name, ref.__localQuery.descriptor));
                    }
                    return Promise.resolve(docSnapshot(ref.parent.id, ref.id));
                },
                set(ref, value, setOptions) {
                    setData(ref.parent.id, ref.id, value, setOptions && setOptions.merge);
                    return transaction;
                },
                update(ref, value) {
                    updateData(ref.parent.id, ref.id, value);
                    return transaction;
                },
                delete(ref) {
                    deleteData(ref.parent.id, ref.id);
                    return transaction;
                }
            };
            return updateFunction(transaction);
        });
    }

    return {
        collection,
        batch,
        runTransaction,
        file,
        flush: persist,
        snapshot: () => clone(store.collections)
    };
}

module.exports = {
    createLocalStore,
    createFieldValue,
    SERVER_TIMESTAMP,
    DELETE_FIELD,
    generateId,
    resolveValue,
    fieldValue,
    compareValues
};
