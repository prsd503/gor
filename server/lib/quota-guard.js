/* Best-effort free-allowance circuit breaker, NOT a billing cap.
 * Monitoring is delayed and other instances/SDK clients can consume quota.
 * Even a rejected HTTP request costs a function invocation. Monitoring errors
 * fail closed in stop mode; process counters are for local testing only.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
    readLimits,
    normalizeAction,
    normalizeSource,
    rollUsage,
    emptyUsage,
    evaluate,
    parseFallbackUrls
} = require('./quota-policy');

const DEFAULT_EXEMPT_PATHS = ['/health', '/api/health', '/api/quota'];
const STATE_SAVE_DEBOUNCE_MS = 500;

function normalizePath(value) {
    const raw = String(value || '/').split('?')[0] || '/';
    return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
}

function createQuotaGuard(options = {}) {
    const env = options.env || process.env;
    const limits = options.limits || readLimits(env);
    const action = normalizeAction(options.action !== undefined ? options.action : env.QUOTA_ACTION);
    const source = normalizeSource(options.source !== undefined ? options.source : env.QUOTA_SOURCE);
    const fallbackUrls = parseFallbackUrls(
        options.fallbackUrls !== undefined ? options.fallbackUrls : (env.QUOTA_FALLBACK_URLS || env.QUOTA_FALLBACK_URL)
    );
    const refreshMs = Math.max(5000, Number(options.refreshMs || env.QUOTA_REFRESH_MS || 60000) || 60000);
    const now = typeof options.now === 'function' ? options.now : () => new Date();
    const logger = options.logger || console;
    const fetchUsage = typeof options.fetchUsage === 'function' ? options.fetchUsage : null;
    // Optional live counters (Firestore read/write counts) merged in on every snapshot.
    const counters = typeof options.counters === 'function' ? options.counters : null;
    const exemptConfig = options.exemptPaths !== undefined ? options.exemptPaths : (env.QUOTA_EXEMPT_PATHS || '');
    const extraExempt = Array.isArray(exemptConfig) ? exemptConfig : String(exemptConfig).split(',');
    const exemptPaths = new Set(DEFAULT_EXEMPT_PATHS);
    for (const entry of extraExempt) {
        const normalized = normalizePath(String(entry).trim());
        if (normalized && normalized !== '/') exemptPaths.add(normalized);
    }
    const stateFile = options.stateFile !== undefined
        ? options.stateFile
        : env.QUOTA_STATE_FILE;

    let usage = readState(stateFile, now());
    let remote = null;
    let lastRefresh = 0;
    let refreshPromise = null;
    let lastWarningAt = 0;
    let monitoringError = null;
    let refreshWindow = null;
    let counterBaseline = { reads: 0, writes: 0, deletes: 0 };
    let counterDay = usage.day;
    let manualDrain = false;
    let saveTimer = null;

    function isExempt(pathname) {
        return exemptPaths.has(normalizePath(pathname));
    }

    function readState(file, clock) {
        if (!file) return emptyUsage(clock);
        try {
            const raw = fs.readFileSync(file, 'utf8');
            const parsed = JSON.parse(raw);
            return rollUsage(parsed && parsed.usage ? parsed.usage : parsed, clock);
        } catch (_) {
            return emptyUsage(clock);
        }
    }

    function persistState() {
        if (!stateFile) return;
        if (saveTimer) return;
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try {
                fs.mkdirSync(path.dirname(stateFile), { recursive: true });
                const tmp = `${stateFile}.tmp`;
                fs.writeFileSync(tmp, JSON.stringify({ usage, savedAt: now().toISOString() }, null, 2));
                fs.renameSync(tmp, stateFile);
            } catch (error) {
                if (logger && typeof logger.warn === 'function') {
                    logger.warn('[quota] Could not persist quota state:', error.message);
                }
            }
        }, STATE_SAVE_DEBOUNCE_MS);
        // Never hold the process open just for bookkeeping.
        if (typeof saveTimer.unref === 'function') saveTimer.unref();
    }

    function record(ops = {}) {
        usage = rollUsage(usage, now());
        let changed = false;
        for (const key of ['reads', 'writes', 'deletes', 'invocations', 'egressBytes']) {
            const delta = Number(ops[key]);
            if (Number.isFinite(delta) && delta > 0) {
                usage[key] += delta;
                changed = true;
            }
        }
        if (changed) persistState();
        return usage;
    }

    /* Monotonic merge: every source only ever increases a meter, so a counter
     * reset (or a cache hit) can never make the guard think usage went down. */
    function effectiveUsage() {
        usage = rollUsage(usage, now());
        const merged = { ...usage };
        if (counters) {
            try {
                const live = counters() || {};
                if (counterDay !== usage.day) {
                    counterBaseline = { ...live };
                    counterDay = usage.day;
                }
                for (const key of ['reads', 'writes', 'deletes']) {
                    const value = Number(live[key]) - (Number(counterBaseline[key]) || 0);
                    if (Number.isFinite(value) && value > merged[key]) merged[key] = value;
                }
            } catch (_) { /* a broken counter must not take the guard down */ }
        }
        if (remote) {
            const currentRemote = rollUsage(remote, now());
            for (const key of ['reads', 'writes', 'deletes', 'invocations', 'egressBytes']) {
                const value = Number(currentRemote[key]);
                if (Number.isFinite(value) && value > merged[key]) merged[key] = value;
            }
        }
        return merged;
    }

    function snapshot() {
        const clock = now();
        const effective = effectiveUsage();
        const verdict = evaluate({ usage: effective, limits, now: clock });
        const monitoringUnavailable = source === 'monitoring' && (!remote || Boolean(monitoringError));
        const draining = action === 'stop' && (verdict.level === 'stop' || manualDrain || monitoringUnavailable);
        return {
            status: draining ? 'stopped' : verdict.level,
            level: verdict.level,
            action,
            source,
            threshold: limits.threshold,
            ratio: verdict.ratio,
            worstMetric: verdict.worstMetric,
            draining,
            manualDrain,
            monitoringUnavailable,
            monitoringError: monitoringError ? 'Usage monitoring unavailable; application work is paused.' : null,
            blocked: verdict.blocked,
            metrics: verdict.metrics.map(metric => ({
                key: metric.key,
                label: metric.label,
                used: metric.used,
                limit: metric.limit,
                ratio: metric.ratio,
                window: metric.window
            })),
            limits,
            usage: effective,
            fallbackUrls,
            remoteUsage: remote,
            remoteCheckedAt: lastRefresh ? new Date(lastRefresh).toISOString() : null,
            generatedAt: clock.toISOString()
        };
    }

    function refresh(force = false) {
        if (source !== 'monitoring') return Promise.resolve(snapshot());
        if (!fetchUsage) { monitoringError = new Error('No monitoring credentials configured'); return Promise.resolve(snapshot()); }
        const window = `${rollUsage(usage, now()).day}/${rollUsage(usage, now()).month}`;
        if (!force && refreshWindow === window && Date.now() - lastRefresh < refreshMs) return Promise.resolve(snapshot());
        if (refreshPromise) return refreshPromise;
        refreshPromise = Promise.resolve()
            .then(() => fetchUsage())
            .then(fetched => {
                if (fetched && typeof fetched === 'object') {
                    const previous = remote ? rollUsage(remote, now()) : emptyUsage(now());
                    remote = {
                        ...emptyUsage(now()),
                        reads: Number(fetched.reads) || 0,
                        writes: Number(fetched.writes) || 0,
                        deletes: Number(fetched.deletes) || 0,
                        invocations: Number(fetched.invocations) || 0,
                        egressBytes: Number(fetched.egressBytes) || 0
                    };
                    for (const key of ['reads', 'writes', 'deletes', 'invocations', 'egressBytes']) {
                        remote[key] = Math.max(remote[key], previous[key]);
                    }
                } else {
                    throw new Error('Empty usage response');
                }
                if (!remote) throw new Error('Empty usage response');
                lastRefresh = Date.now();
                refreshWindow = window;
                monitoringError = null;
                lastWarningAt = 0;
            })
            .catch(error => {
                monitoringError = error;
                lastRefresh = Date.now();
                refreshWindow = window;
                // Log once every 10 minutes instead of on every request.
                if (Date.now() - lastWarningAt > 600000 && logger && typeof logger.warn === 'function') {
                    lastWarningAt = Date.now();
                    logger.warn('[quota] Cloud Monitoring usage check failed; stop mode fails closed:', error.message);
                }
            })
            .then(() => {
                refreshPromise = null;
                return snapshot();
            });
        return refreshPromise;
    }

    function quotaBody(snap) {
        return {
            error: snap.monitoringUnavailable ? 'Usage monitoring is unavailable; application work is paused.' : 'This server has reached its Firebase free-tier safety limit and has stopped taking requests.',
            code: snap.monitoringUnavailable ? 'quota-monitoring-unavailable' : 'quota-threshold-reached',
            level: snap.level,
            threshold: snap.threshold,
            blocked: snap.blocked,
            usage: snap.usage,
            fallback: snap.fallbackUrls,
            retryAfterSeconds: 3600
        };
    }

    function sendStopped(res, snap) {
        if (res.headersSent) return;
        res.status(503);
        res.set('Retry-After', '3600');
        res.set('Cache-Control', 'no-store');
        res.set('X-Owl-Drain', '1');
        res.set('X-Owl-Quota-Level', 'stop');
        if (snap.fallbackUrls.length) res.set('X-Owl-Fallback-Url', snap.fallbackUrls[0]);
        res.json(quotaBody(snap));
    }

    /* Express middleware. Cheap in the common case: one snapshot per request and
     * an async monitoring refresh at most once per QUOTA_REFRESH_MS. */
    async function middleware(req, res, next) {
        const exempt = isExempt(req.path || req.url);
        // On cold start and cache expiry, WAIT for usage before allowing work.
        if (!exempt && action !== 'off') await refresh();
        record({ invocations: 1 });
        const snap = snapshot();
        res.setHeader('X-Owl-Quota-Level', snap.level);
        res.setHeader('X-Owl-Quota-Used', (snap.ratio * 100).toFixed(2));
        res.on('finish', () => {
            const raw = typeof res.getHeader === 'function' ? res.getHeader('content-length') : null;
            record({ egressBytes: Number(raw) || 0 });
        });
        if (snap.draining && !exempt) return sendStopped(res, snap);
        return next();
    }

    // GET /api/quota — always reachable so the website and you can see the state.
    function handler(req, res) {
        const snap = snapshot();
        res.set('Cache-Control', 'no-store');
        res.status(200).json(snap);
    }

    function stop() {
        manualDrain = true;
        return snapshot();
    }

    function resume() {
        manualDrain = false;
        return snapshot();
    }

    function reset() {
        usage = emptyUsage(now());
        remote = null;
        lastRefresh = 0;
        refreshWindow = null;
        monitoringError = null;
        manualDrain = false;
        persistState();
    }

    function close() {
        if (saveTimer) {
            clearTimeout(saveTimer);
            saveTimer = null;
        }
    }

    return {
        limits,
        action,
        source,
        middleware,
        handler,
        record,
        refresh,
        snapshot,
        isDraining: () => snapshot().draining,
        stop,
        resume,
        reset,
        close,
        exemptPaths: Array.from(exemptPaths)
    };
}

module.exports = { createQuotaGuard, DEFAULT_EXEMPT_PATHS, normalizePath };
