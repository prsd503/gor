/* Background routines for the long-running MacBook/server process.
 *
 * node-cron v4 only runs in a process that stays alive. Firebase uses a
 * separate scheduled function for notice rollover.
 */
'use strict';

const cron = require('node-cron');
const { effectiveNotice } = require('./notices');

const BOOKING_RETENTION_DAYS = 7;
/* Attempt records exist to stop a duplicate spin for one contest on one day, and
 * `spinStats` day buckets exist for the lifetime/month totals. Keeping them
 * forever means every scan (and the storage bill) grows without bound, so the
 * retention job trims attempts after a week and daily buckets after five years -
 * long past any reporting window, and neither is ever written again. */
const ATTEMPT_RETENTION_DAYS = 7;
const SPIN_STATS_RETENTION_DAYS = 365 * 5;

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

    function isoDay(offsetDays) {
        const date = new Date();
        date.setUTCDate(date.getUTCDate() - offsetDays);
        return date.toISOString().slice(0, 10);
    }

    /* Deletes only records that can never be read again: spin attempts older
     * than a week (the duplicate-spin check only looks at today and yesterday)
     * and day buckets older than the retention window. Returns what it removed. */
    async function pruneSpinHistory() {
        const removed = { attempts: 0, spinStats: 0 };
        if (options.beforeRun && !await options.beforeRun()) return removed;
        const attemptBefore = isoDay(ATTEMPT_RETENTION_DAYS);
        let attempts = null;
        try {
            attempts = await db.collection('contestAttempts').where('date', '<', attemptBefore).get();
        } catch (_) {
            // Records without a `date` field are matched by `createdAt` instead.
            attempts = await db.collection('contestAttempts')
                .where('createdAt', '<', new Date(`${attemptBefore}T00:00:00.000Z`)).get();
        }
        if (!attempts.empty) {
            removed.attempts = await commitChunks(attempts.docs.map(doc => batch => batch.delete(doc.ref)));
        }
        try {
            const stats = await db.collection('spinStats').where('date', '<', isoDay(SPIN_STATS_RETENTION_DAYS)).get();
            if (!stats.empty) {
                removed.spinStats = await commitChunks(stats.docs.map(doc => batch => batch.delete(doc.ref)));
            }
        } catch (_) { /* A missing index must not fail the whole maintenance run. */ }
        if (removed.attempts || removed.spinStats) {
            logger.log(`[maintenance] Pruned ${removed.attempts} spin attempt(s) and ${removed.spinStats} old spin bucket(s).`);
        }
        return removed;
    }

    async function checkAndShiftNotices() {
        const noticesSnapshot = await db.collection('notices').get();
        if (noticesSnapshot.empty) return 0;
        let updated = 0;
        for (const doc of noticesSnapshot.docs) {
            if (options.beforeRun && !await options.beforeRun()) throw new Error('Notice rollover interrupted by quota drain.');
            // Re-read in a transaction so a concurrent admin edit or another
            // scheduler cannot be overwritten by a stale collection snapshot.
            const shifted = await db.runTransaction(async tx => {
                const fresh = await tx.get(doc.ref);
                if (!fresh.exists) return false;
                const next = effectiveNotice(fresh.data() || {}, options.now ? options.now() : new Date());
                if (!next.due) return false;
                const fields = { date: next.date, noticeCycle: next.noticeCycle,
                    todayMessage: next.todayMessage, tomorrowMessage: next.tomorrowMessage };
                if (FieldValue && FieldValue.serverTimestamp) fields.updatedAt = FieldValue.serverTimestamp();
                tx.update(doc.ref, fields);
                return true;
            });
            if (shifted) updated++;
        }
        if (updated) logger.log(`[maintenance] Shifted ${updated} notice(s).`);
        return updated;
    }

    async function runAll() {
        const result = { noticesShifted: 0, bookingsDeleted: 0 };
        if (options.beforeRun && !await options.beforeRun()) return { ...result, skipped: 'quota-drain' };
        try {
            result.noticesShifted = await checkAndShiftNotices();
            result.bookingsDeleted = await cleanupOldBookings();
            // Retention: this is the only job that ever deletes old spin data.
            const pruned = await pruneSpinHistory();
            if (pruned.attempts) result.attemptsDeleted = pruned.attempts;
            if (pruned.spinStats) result.spinStatsDeleted = pruned.spinStats;
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

    // v4 schedule() starts automatically; the v3 `scheduled` option is gone.
    // Return the promise so noOverlap covers the whole asynchronous DB job.
    // This prevents overlap in this process, not across multiple servers.
    function schedule(expression = '0 0 * * *') {
        return cron.schedule(expression, () => runAll().catch(() => {}), {
            timezone: timeZone,
            noOverlap: true
        });
    }

    return { cleanupOldBookings, checkAndShiftNotices, pruneSpinHistory, runAll, schedule, lastRun, timeZone };
}

module.exports = { createMaintenance, BOOKING_RETENTION_DAYS, ATTEMPT_RETENTION_DAYS, SPIN_STATS_RETENTION_DAYS };
