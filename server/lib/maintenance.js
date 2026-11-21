/* Background routines shared by the long-running server and the Firebase
 * scheduled function.
 *
 * `node-cron` only works in a process that stays alive (the MacBook copy). On
 * Cloud Functions the `maintenance` scheduled function calls runAll() instead,
 * because instances are frozen between requests.
 */
'use strict';

const cron = require('node-cron');

const BOOKING_RETENTION_DAYS = 7;

function createMaintenance(options = {}) {
    const db = options.db;
    const FieldValue = options.FieldValue;
    const logger = options.logger || console;
    const timeZone = options.timeZone || 'Asia/Kolkata';
    const lastRun = { at: null, noticesShifted: 0, bookingsDeleted: 0, error: null };

    if (!db) throw new Error('createMaintenance requires a db handle.');

    async function commitChunks(operations) {
        let committed = 0;
        for (let i = 0; i < operations.length; i += 400) {
            if (options.beforeRun && !await options.beforeRun()) break;
            const batch = db.batch();
            for (const operation of operations.slice(i, i + 400)) operation(batch);
            await batch.commit();
            committed += Math.min(400, operations.length - i);
        }
        return committed;
    }

    async function cleanupOldBookings() {
        const threshold = new Date();
        threshold.setDate(threshold.getDate() - BOOKING_RETENTION_DAYS);
        const snapshot = await db.collection('bookings').where('end', '<', threshold.toISOString()).get();
        if (snapshot.empty) return 0;
        const deleted = await commitChunks(snapshot.docs.map(doc => batch => batch.delete(doc.ref)));
        logger.log(`[maintenance] Removed ${deleted} expired booking(s).`);
        return deleted;
    }

    async function checkAndShiftNotices() {
        const noticesSnapshot = await db.collection('notices').get();
        if (noticesSnapshot.empty) return 0;
        const today = new Date().toLocaleDateString('en-CA', { timeZone });
        const operations = [];
        noticesSnapshot.forEach(doc => {
            const data = doc.data() || {};
            if (data.date && data.date !== today) {
                const next = {
                    todayMessage: data.tomorrowMessage || '',
                    tomorrowMessage: '',
                    date: today
                };
                if (FieldValue && FieldValue.serverTimestamp) next.updatedAt = FieldValue.serverTimestamp();
                operations.push(batch => batch.update(doc.ref, next));
            }
        });
        const updated = await commitChunks(operations);
        if (updated) logger.log(`[maintenance] Shifted ${updated} notice(s) for ${today}.`);
        return updated;
    }

    async function runAll() {
        const result = { noticesShifted: 0, bookingsDeleted: 0 };
        if (options.beforeRun && !await options.beforeRun()) return { ...result, skipped: 'quota-drain' };
        try {
            result.noticesShifted = await checkAndShiftNotices();
            result.bookingsDeleted = await cleanupOldBookings();
            lastRun.at = new Date().toISOString();
            lastRun.noticesShifted = result.noticesShifted;
            lastRun.bookingsDeleted = result.bookingsDeleted;
            lastRun.error = null;
            return result;
        } catch (error) {
            lastRun.at = new Date().toISOString();
            lastRun.error = error.message;
            logger.error('[maintenance] Run failed:', error.message);
            throw error;
        }
    }

    // Long-running deployments only. Cloud Functions use the scheduled function.
    function schedule(expression = '0 0 * * *') {
        return cron.schedule(expression, () => {
            runAll().catch(() => {});
        }, { scheduled: true, timezone: timeZone });
    }

    return { cleanupOldBookings, checkAndShiftNotices, runAll, schedule, lastRun, timeZone };
}

module.exports = { createMaintenance, BOOKING_RETENTION_DAYS };
