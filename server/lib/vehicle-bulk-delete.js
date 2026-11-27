/* Bulk vehicle delete for one society.
 *
 * The admin portal uploads a parsed CSV (first column = plate, already split by
 * the browser). This service matches those plates against the society's
 * registry and deletes them in batches, reporting per plate what happened:
 *
 *   deleted  - the plate was found and its document removed;
 *   notFound - the plate is not in this society (nothing to do);
 *   skipped  - the plate was blank or appeared twice in the file;
 *   failed   - the document could not be removed.
 *
 * Plates belonging to another society are never touched, because matching only
 * uses this society's documents.
 */
'use strict';

const MAX_PLATES = 2000;
const BATCH_LIMIT = 400;

function normalize(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function normalizePlate(value) {
    return String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, ' ');
}

function createVehicleBulkDelete(options) {
    const db = options.db;
    if (!db) throw new Error('createVehicleBulkDelete requires a db handle.');

    async function run(society, rawPlates) {
        const summary = { requested: 0, deleted: 0, notFound: 0, skipped: 0, failed: 0, plates: [], missing: [], errors: [], truncated: false };
        const input = Array.isArray(rawPlates) ? rawPlates : [];
        summary.truncated = input.length > MAX_PLATES;
        const allowed = new Set();
        const plates = [];
        for (const raw of input.slice(0, MAX_PLATES)) {
            const plate = normalizePlate(raw);
            if (!plate) {
                summary.skipped += 1;
                continue;
            }
            if (!/^[A-Z0-9 -]{1,20}$/.test(plate)) {
                summary.errors.push({ plate, reason: 'Vehicle number contains unsupported characters.' });
                summary.failed += 1;
                continue;
            }
            if (allowed.has(plate)) {
                summary.skipped += 1;
                summary.plates.push({ plate, action: 'skipped', reason: 'Listed twice in this file.' });
                continue;
            }
            allowed.add(plate);
            plates.push(plate);
        }
        summary.requested = plates.length;

        if (!plates.length) return summary;

        const aliases = society.aliases.slice(0, 30);
        const snapshots = await Promise.all([
            db.collection('vehicles').where('societyId', '==', society.id).get(),
            db.collection('vehicles').where('societyName', 'in', aliases).get(),
            db.collection('vehicles').where('society', 'in', aliases).get()
        ]);
        const wanted = new Map(plates.map(plate => [plate, []]));
        const seen = new Set();
        for (const snapshot of snapshots) {
            snapshot.forEach(doc => {
                if (seen.has(doc.id)) return;
                const data = doc.data() || {};
                if (!vehicleBelongsTo(data, doc.id, society)) return;
                const plate = normalizePlate(data.vehicleNumber);
                if (!wanted.has(plate)) return;
                seen.add(doc.id);
                wanted.get(plate).push(doc.id);
            });
        }

        const deletions = [];
        for (const plate of plates) {
            const ids = wanted.get(plate);
            if (!ids.length) {
                summary.notFound += 1;
                summary.missing.push(plate);
                summary.plates.push({ plate, action: 'notFound', reason: `Not registered in ${society.name}.` });
                continue;
            }
            for (const id of ids) deletions.push({ plate, id });
        }

        let removed = 0;
        for (let i = 0; i < deletions.length; i += BATCH_LIMIT) {
            const chunk = deletions.slice(i, i + BATCH_LIMIT);
            try {
                const batch = db.batch();
                for (const item of chunk) batch.delete(db.collection('vehicles').doc(item.id));
                await batch.commit();
                removed += chunk.length;
            } catch (_) {
                // Fall back to individual deletes so one bad document cannot
                // block the rest of the file.
                for (const item of chunk) {
                    try {
                        await db.collection('vehicles').doc(item.id).delete();
                        removed += 1;
                    } catch (err) {
                        summary.failed += 1;
                        summary.errors.push({ plate: item.plate, reason: 'Could not delete this record.' });
                    }
                }
            }
        }
        summary.deleted = removed;
        for (const plate of plates) {
            if (wanted.get(plate).length) summary.plates.push({ plate, action: 'deleted' });
        }
        summary.plates.sort((a, b) => a.plate.localeCompare(b.plate));
        return summary;
    }

    return { run, MAX_PLATES };
}

function vehicleBelongsTo(data, docId, society) {
    if (data && data.societyId) return data.societyId === society.id;
    const aliases = new Set(society.aliases.map(normalize));
    return aliases.has(normalize(docId)) ||
        [data && data.society, data && data.societyName].some(value => aliases.has(normalize(value)));
}

module.exports = { createVehicleBulkDelete, normalizePlate, MAX_PLATES };
