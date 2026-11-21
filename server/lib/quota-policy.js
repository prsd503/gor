/* Free-tier quota policy for the Firebase-hosted copy of this API.
 *
 * The numbers below are the no-cost allowances published on Firebase's pricing
 * page (Spark plan, and the identical no-cost band on Blaze):
 *
 *   Firestore document reads     50,000 / day
 *   Firestore document writes    20,000 / day
 *   Firestore document deletes   20,000 / day
 *   Cloud Functions invocations   2,000,000 / month   (Blaze only)
 *   Cloud Functions egress        5 GB / month        (Blaze only)
 *
 * Everything in this module is pure: it takes a usage snapshot and returns a
 * verdict, so the arithmetic is unit-testable without a Firebase project.
 *
 * The important knob is QUOTA_THRESHOLD (default 0.8): once any meter reaches
 * 80% of its configured allowance the hosted copy pauses /api application work.
 * This is a best-effort circuit breaker, NOT a billing cap. Clients then fail over to the MacBook copy
 * (see api-config.js) or show "try again later".
 */
'use strict';

const BYTES_PER_GB = 1e9;

const FREE_TIER_LIMITS = Object.freeze({
    readsPerDay: 50000,
    writesPerDay: 20000,
    deletesPerDay: 20000,
    invocationsPerMonth: 2000000,
    egressGbPerMonth: 5
});

const DEFAULT_THRESHOLD = 0.8;
// "warn" is reported at this fraction of the stop threshold (80% * 75% = 60%).
const WARN_FRACTION_OF_THRESHOLD = 0.75;

const ACTIONS = Object.freeze(['stop', 'monitor', 'off']);
const SOURCES = Object.freeze(['local', 'monitoring']);

function positiveNumber(value, fallback) {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeThreshold(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_THRESHOLD;
    // A threshold above 1 would never stop before the allowance is exhausted.
    return Math.min(parsed, 1);
}

function normalizeAction(value) {
    const action = String(value || '').trim().toLowerCase();
    return ACTIONS.includes(action) ? action : 'stop';
}

function normalizeSource(value) {
    const source = String(value || '').trim().toLowerCase();
    return SOURCES.includes(source) ? source : 'local';
}

/* Read limits from the environment. Each value can be overridden so the same
 * code protects a different plan (or a self-imposed lower ceiling). */
function readLimits(env = {}) {
    return {
        readsPerDay: positiveNumber(env.QUOTA_DAILY_READ_LIMIT, FREE_TIER_LIMITS.readsPerDay),
        writesPerDay: positiveNumber(env.QUOTA_DAILY_WRITE_LIMIT, FREE_TIER_LIMITS.writesPerDay),
        deletesPerDay: positiveNumber(env.QUOTA_DAILY_DELETE_LIMIT, FREE_TIER_LIMITS.deletesPerDay),
        invocationsPerMonth: positiveNumber(env.QUOTA_MONTHLY_INVOCATION_LIMIT, FREE_TIER_LIMITS.invocationsPerMonth),
        egressGbPerMonth: positiveNumber(env.QUOTA_MONTHLY_EGRESS_GB_LIMIT, FREE_TIER_LIMITS.egressGbPerMonth),
        threshold: normalizeThreshold(env.QUOTA_THRESHOLD)
    };
}

function dayKey(date) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function monthKey(date) {
    return date.toISOString().slice(0, 7);
}

function emptyUsage(now = new Date()) {
    return {
        day: dayKey(now),
        month: monthKey(now),
        reads: 0,
        writes: 0,
        deletes: 0,
        invocations: 0,
        egressBytes: 0
    };
}

/* Firestore's daily free allowance resets at Pacific midnight (including DST).
 * Monthly counters use a UTC calendar month. */
function rollUsage(usage, now = new Date()) {
    const base = usage && typeof usage === 'object' ? usage : {};
    const rolled = {
        ...emptyUsage(now),
        ...base,
        day: dayKey(now),
        month: monthKey(now)
    };
    if (base.day !== rolled.day) {
        rolled.reads = 0;
        rolled.writes = 0;
        rolled.deletes = 0;
    }
    if (base.month !== rolled.month) {
        rolled.invocations = 0;
        rolled.egressBytes = 0;
    }
    return normalizeCounters(rolled);
}

function normalizeCounters(usage) {
    const out = { ...usage };
    for (const key of ['reads', 'writes', 'deletes', 'invocations', 'egressBytes']) {
        const value = Number(out[key]);
        out[key] = Number.isFinite(value) && value > 0 ? value : 0;
    }
    return out;
}

function metricList(usage, limits) {
    return [
        { key: 'reads', label: 'Firestore reads', used: usage.reads, limit: limits.readsPerDay, window: 'day' },
        { key: 'writes', label: 'Firestore writes', used: usage.writes, limit: limits.writesPerDay, window: 'day' },
        { key: 'deletes', label: 'Firestore deletes', used: usage.deletes, limit: limits.deletesPerDay, window: 'day' },
        { key: 'invocations', label: 'Function invocations', used: usage.invocations, limit: limits.invocationsPerMonth, window: 'month' },
        {
            key: 'egress',
            label: 'Function egress (GB)',
            used: usage.egressBytes / BYTES_PER_GB,
            limit: limits.egressGbPerMonth,
            window: 'month'
        }
    ].map(metric => ({
        ...metric,
        ratio: metric.limit > 0 ? metric.used / metric.limit : 0
    }));
}

/* Turn raw usage into a verdict.
 *
 * level: 'ok'   - comfortably below the threshold
 *        'warn' - approaching the threshold
 *        'stop' - at or above the threshold; the hosted copy must stop
 */
function evaluate({ usage, limits, now = new Date() }) {
    const normalized = normalizeCounters(usage || emptyUsage(now));
    const metrics = metricList(normalized, limits);
    const worst = metrics.reduce((acc, metric) => (metric.ratio > acc.ratio ? metric : acc), metrics[0]);
    const blocked = metrics.filter(metric => metric.ratio >= limits.threshold);
    const level = blocked.length
        ? 'stop'
        : (worst.ratio + Number.EPSILON >= limits.threshold * WARN_FRACTION_OF_THRESHOLD ? 'warn' : 'ok');

    return {
        level,
        ratio: worst.ratio,
        worstMetric: worst.key,
        blocked: blocked.map(metric => ({
            key: metric.key,
            label: metric.label,
            used: metric.used,
            limit: metric.limit,
            ratio: metric.ratio,
            window: metric.window
        })),
        metrics
    };
}

function formatMetric(metric) {
    const used = metric.key === 'egress' ? metric.used.toFixed(3) : Math.round(metric.used);
    const limit = metric.key === 'egress' ? metric.limit : Math.round(metric.limit);
    return `${metric.label}: ${used} / ${limit} (${(metric.ratio * 100).toFixed(1)}%)`;
}

/* Comma-separated list of client-facing base URLs, e.g. the MacBook tunnel. */
function parseFallbackUrls(value) {
    if (!value) return [];
    const raw = Array.isArray(value) ? value : String(value).split(',');
    return raw
        .map(entry => String(entry).trim().replace(/\/+$/, ''))
        .filter(Boolean);
}

module.exports = {
    BYTES_PER_GB,
    FREE_TIER_LIMITS,
    DEFAULT_THRESHOLD,
    ACTIONS,
    SOURCES,
    readLimits,
    normalizeThreshold,
    normalizeAction,
    normalizeSource,
    normalizeCounters,
    emptyUsage,
    rollUsage,
    dayKey,
    monthKey,
    metricList,
    evaluate,
    formatMetric,
    parseFallbackUrls
};
