/* Bulk vehicle import for one society.
 *
 * The admin portal uploads a parsed CSV (rows already split by the browser) and
 * this service writes them with an explicit, auditable rule set:
 *
 *   - a row whose plate already exists in the society is *updated* only when it
 *     would change something; identical rows are reported as duplicates and
 *     left untouched (`repeat`), so re-uploading the same file is harmless;
 *   - rows with a plate that appear twice inside the same file are duplicates;
 *   - a row pointing at a flat that is not in the society's `flatList` is
 *     rejected with a reason instead of being written;
 *   - everything is validated before a single write, so a bad row cannot leave
 *     the import half-finished.
 *
 * Records created by the resident flow carry a `deviceId`; an import never
 * rewrites the device binding or moves such a vehicle to another flat.
 */
'use strict';

const { registrationLockId, totalVehicleLimit } = require('./vehicle-limit');

const VEHICLE_TYPES = ['2-Wheeler', '3-Wheeler', '4-Wheeler'];
const MAX_ROWS = 2000;
const BATCH_LIMIT = 400;

function normalize(value) {
    return String(value == null ? '' : value).trim().toLowerCase();
}

function normalizeVehicleType(value) {
    const raw = String(value == null ? '' : value).trim();
    if (/^2\s*-?\s*w(heeler)?$/i.test(raw)) return '2-Wheeler';
    if (/^3\s*-?\s*w(heeler)?$/i.test(raw)) return '3-Wheeler';
    if (/^4\s*-?\s*w(heeler)?$/i.test(raw)) return '4-Wheeler';
    return VEHICLE_TYPES.includes(raw) ? raw : null;
}

function normalizePlate(value) {
    return String(value == null ? '' : value).trim().toUpperCase().replace(/\s+/g, ' ');
}

function normalizeMobile(value) {
    const digits = String(value == null ? '' : value).replace(/\D/g, '');
    if (!digits) return '';
    return digits.length > 10 ? digits.slice(-10) : digits;
}

const HEADER_ALIASES = {
    vehicleNumber: ['vehiclenumber', 'vehicle no', 'vehicle_no', 'plate', 'platenumber', 'registrationnumber', 'vehicle'],
    flatNumber: ['flatnumber/name', 'flatnumber', 'flat no', 'flat_no', 'flat', 'flatname', 'flatnumbername'],
    residentType: ['residenttype', 'resident', 'type of resident', 'occupancy'],
    mobileNumber: ['mobilenumber', 'mobile', 'mobile no', 'phone', 'contact'],
    vehicleType: ['vehicletype', 'vehicle type', 'wheeler', 'category']
};

function pick(row, keys) {
    for (const key of Object.keys(row)) {
        if (keys.includes(normalize(key))) return row[key];
    }
    return '';
}

function createVehicleImport(options) {
    const db = options.db;
    const FieldValue = options.FieldValue;
    if (!db) throw new Error('createVehicleImport requires a db handle.');

    function result() {
        return { added: 0, updated: 0, repeat: 0, rejected: 0, total: 0, changes: [], errors: [], truncated: false };
    }

    async function run(society, rawRows) {
        const summary = result();
        if (!Array.isArray(rawRows)) return summary;
        if (rawRows.length > MAX_ROWS) {
            summary.truncated = true;
            rawRows = rawRows.slice(0, MAX_ROWS);
        }
        summary.total = rawRows.length;
        if (!rawRows.length) return summary;

        // Existing registry for this society, keyed by plate.
        const aliases = society.aliases.slice(0, 30);
        const snapshots = await Promise.all([
            db.collection('vehicles').where('societyId', '==', society.id).get({ fresh: true }),
            db.collection('vehicles').where('societyName', 'in', aliases).get({ fresh: true }),
            db.collection('vehicles').where('society', 'in', aliases).get({ fresh: true })
        ]);
        const byPlate = new Map();
        for (const snapshot of snapshots) {
            snapshot.forEach(doc => {
                const data = doc.data() || {};
                if (!vehicleBelongsTo(data, doc.id, society)) return;
                const plate = normalizePlate(data.vehicleNumber);
                if (plate && !byPlate.has(plate)) byPlate.set(plate, { id: doc.id, data });
            });
        }

        const societyDoc = await db.collection('societies').doc(society.id).get({ fresh: true });
        const societyData = societyDoc.exists ? societyDoc.data() || {} : {};
        const flatList = Array.isArray(societyData.flatList) ? societyData.flatList
            : (Array.isArray(societyData.flats) ? societyData.flats : []);
        const knownFlats = new Map(flatList.map(flat => [normalize(flat), String(flat)]));

        const planned = [];
        const seenInFile = new Map();

        rawRows.forEach((rawRow, index) => {
            const line = index + 1;
            const row = rawRow && typeof rawRow === 'object' && !Array.isArray(rawRow)
                ? rawRow
                : { vehicleNumber: Array.isArray(rawRow) ? rawRow[0] : '', flatNumber: Array.isArray(rawRow) ? rawRow[1] : '' };

            const plate = normalizePlate(pick(row, HEADER_ALIASES.vehicleNumber));
            if (!plate) {
                summary.rejected += 1;
                summary.errors.push({ line, plate: '', reason: 'Missing vehicle number.' });
                return;
            }
            if (!/^[A-Z0-9 -]{1,20}$/.test(plate)) {
                summary.rejected += 1;
                summary.errors.push({ line, plate, reason: 'Vehicle number contains unsupported characters.' });
                return;
            }
            if (seenInFile.has(plate)) {
                summary.repeat += 1;
                summary.changes.push({ line, plate, action: 'repeat', reason: `Duplicate of line ${seenInFile.get(plate)} in this file.` });
                return;
            }
            seenInFile.set(plate, line);

            const flatRaw = String(pick(row, HEADER_ALIASES.flatNumber) || '').trim();
            if (!flatRaw) {
                summary.rejected += 1;
                summary.errors.push({ line, plate, reason: 'Missing flat number/name.' });
                return;
            }
            const flat = flatList.length ? knownFlats.get(normalize(flatRaw)) : flatRaw;
            if (flatList.length && !flat) {
                summary.rejected += 1;
                summary.errors.push({ line, plate, reason: `Flat "${flatRaw}" is not registered in ${society.name}.` });
                return;
            }

            const residentRaw = String(pick(row, HEADER_ALIASES.residentType) || '').trim();
            // Blank stays blank (the row is stored as "Resident"), anything else
            // must be Owner/Tenant so a typo is never silently written.
            const residentType = !residentRaw ? ''
                : /^owner$/i.test(residentRaw) ? 'Owner'
                    : /^tenant$/i.test(residentRaw) ? 'Tenant'
                        : null;
            if (residentType === null) {
                summary.rejected += 1;
                summary.errors.push({ line, plate, reason: 'Resident type must be Owner or Tenant.' });
                return;
            }

            const mobileNumber = normalizeMobile(pick(row, HEADER_ALIASES.mobileNumber));
            if (mobileNumber && mobileNumber.length !== 10) {
                summary.rejected += 1;
                summary.errors.push({ line, plate, reason: 'Mobile number must contain 10 digits.' });
                return;
            }

            const typeRaw = pick(row, HEADER_ALIASES.vehicleType);
            const vehicleType = typeRaw ? normalizeVehicleType(typeRaw) : '2-Wheeler';
            if (!vehicleType) {
                summary.rejected += 1;
                summary.errors.push({ line, plate, reason: 'Vehicle type must be 2-Wheeler, 3-Wheeler or 4-Wheeler.' });
                return;
            }

            planned.push({ line, plate, flat, residentType, mobileNumber, vehicleType });
        });

        const stamp = FieldValue ? FieldValue.serverTimestamp() : new Date().toISOString();
        const creates = [];
        const updates = [];

        for (const row of planned) {
            const existing = byPlate.get(row.plate);
            if (!existing) {
                creates.push(row);
                continue;
            }
            const data = existing.data || {};
            const next = {
                flatNumber: row.flat,
                residentType: row.residentType || data.residentType || 'Resident',
                mobileNumber: row.mobileNumber || data.mobileNumber || '',
                vehicleType: row.vehicleType,
                vehicleNumber: row.plate
            };
            if (data.deviceId && normalize(data.flatNumber) !== normalize(row.flat)) {
                summary.rejected += 1;
                summary.errors.push({
                    line: row.line, plate: row.plate,
                    reason: `Vehicle is device-linked to flat ${data.flatNumber}; change it from the search screen.`
                });
                continue;
            }
            const changed = normalize(data.flatNumber) !== normalize(next.flatNumber) ||
                normalize(data.residentType) !== normalize(next.residentType) ||
                String(data.mobileNumber || '') !== next.mobileNumber ||
                String(data.vehicleType || '') !== next.vehicleType ||
                normalizePlate(data.vehicleNumber) !== next.vehicleNumber;
            if (!changed) {
                summary.repeat += 1;
                summary.changes.push({ line: row.line, plate: row.plate, action: 'repeat', reason: 'Already stored with the same details.' });
                continue;
            }
            updates.push({ ...row, id: existing.id, next });
        }

        async function commit(groups) {
            for (let i = 0; i < groups.length; i += BATCH_LIMIT) {
                const batch = db.batch();
                for (const operation of groups.slice(i, i + BATCH_LIMIT)) operation(batch);
                await batch.commit();
            }
        }

        // All creation paths share the society registration lock. Each chunk
        // re-reads the cap and current vehicles inside a transaction, so a
        // simultaneous resident registration or import cannot exceed it.
        const lockRef = db.collection('vehicleRegistrationLocks').doc(registrationLockId(society.id));
        const societyRef = db.collection('societies').doc(society.id);
        for (let i = 0; i < creates.length; i += 100) {
            const chunk = creates.slice(i, i + 100).map(row => ({ ...row, ref: db.collection('vehicles').doc() }));
            const outcomes = await db.runTransaction(async tx => {
                const [societySnap, lockSnap, ...snapshots] = await Promise.all([
                    tx.get(societyRef), tx.get(lockRef),
                    tx.get(db.collection('vehicles').where('societyId', '==', society.id)),
                    tx.get(db.collection('vehicles').where('societyName', 'in', aliases)),
                    tx.get(db.collection('vehicles').where('society', 'in', aliases))
                ]);
                if (!societySnap.exists) throw new Error('Society no longer exists.');
                const current = new Map();
                for (const snapshot of snapshots) snapshot.forEach(doc => {
                    const data = doc.data() || {};
                    if (vehicleBelongsTo(data, doc.id, society)) current.set(doc.id, data);
                });
                const existingPlates = new Set([...current.values()].map(data => normalizePlate(data.vehicleNumber)).filter(Boolean));
                let count = current.size;
                const freshSociety = societySnap.data() || {};
                const max = totalVehicleLimit(freshSociety);
                const currentFlats = Array.isArray(freshSociety.flatList) ? freshSociety.flatList : (Array.isArray(freshSociety.flats) ? freshSociety.flats : []);
                const known = new Set(currentFlats.filter(flat => typeof flat === 'string' && flat.trim()).map(normalize));
                const result = [];
                let added = 0;
                for (const row of chunk) {
                    if (existingPlates.has(row.plate)) {
                        result.push({ row, action: 'repeat', reason: 'Vehicle was registered while the import was running.' });
                    } else if (known.size && !known.has(normalize(row.flat))) {
                        result.push({ row, action: 'rejected', reason: 'Flat is no longer registered in this society.' });
                    } else if (max !== null && count >= max) {
                        result.push({ row, action: 'rejected', reason: `Society vehicle limit of ${max} reached.` });
                    } else {
                        tx.set(row.ref, {
                            societyId: society.id, societyName: society.name, flatNumber: row.flat,
                            residentType: row.residentType || 'Resident', mobileNumber: row.mobileNumber || '',
                            vehicleType: row.vehicleType, vehicleNumber: row.plate, deviceId: null, createdAt: stamp
                        });
                        existingPlates.add(row.plate);
                        count++; added++;
                        result.push({ row, action: 'added' });
                    }
                }
                if (added) {
                    const version = lockSnap.exists ? Number((lockSnap.data() || {}).version) || 0 : 0;
                    tx.set(lockRef, { societyId: society.id, version: version + 1, updatedAt: stamp });
                }
                return result;
            });
            for (const { row, action, reason } of outcomes) {
                if (action === 'rejected') {
                    summary.rejected++;
                    summary.errors.push({ line: row.line, plate: row.plate, reason });
                } else {
                    summary[action]++;
                    summary.changes.push({ line: row.line, plate: row.plate, action, flat: row.flat, ...(reason ? { reason } : {}) });
                }
            }
        }
        await commit(updates.map(row => batch => batch.update(db.collection('vehicles').doc(row.id), {
            ...row.next,
            societyId: society.id,
            societyName: society.name,
            updatedAt: stamp
        })));

        for (const row of updates) {
            summary.updated += 1;
            summary.changes.push({ line: row.line, plate: row.plate, action: 'updated', flat: row.flat });
        }
        summary.changes.sort((a, b) => a.line - b.line);
        return summary;
    }

    return { run, MAX_ROWS };
}

function vehicleBelongsTo(data, docId, society) {
    if (data && data.societyId) return data.societyId === society.id;
    const aliases = new Set(society.aliases.map(normalize));
    return aliases.has(normalize(docId)) ||
        [data && data.society, data && data.societyName].some(value => aliases.has(normalize(value)));
}

module.exports = { createVehicleImport, normalizeVehicleType, normalizePlate, MAX_ROWS };
