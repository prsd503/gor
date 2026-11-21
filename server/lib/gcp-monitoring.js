/* Project-wide delayed usage estimates for Firestore and Cloud Run (Functions v2).
 * Requires roles/monitoring.viewer on the runtime service account. These are
 * usage metrics, not an authoritative billing ledger. Failures are handled by
 * the guard, which fails closed in stop mode.
 */
'use strict';

const METRICS = Object.freeze({
    reads: 'firestore.googleapis.com/document/read_count',
    writes: 'firestore.googleapis.com/document/write_count',
    deletes: 'firestore.googleapis.com/document/delete_count',
    invocations: 'run.googleapis.com/request_count',
    egressBytes: 'run.googleapis.com/container/network/sent_bytes_count'
});

const REQUEST_TIMEOUT_MS = 8000;
const { dayKey } = require('./quota-policy');

function startOfPacificDay(date) {
    const wall = Date.parse(dayKey(date) + 'T00:00:00Z');
    let candidate = wall;
    for (let i = 0; i < 2; i++) {
        const offset = new Intl.DateTimeFormat('en', { timeZone: 'America/Los_Angeles', timeZoneName: 'longOffset' }).formatToParts(new Date(candidate)).find(p => p.type === 'timeZoneName').value;
        const match = offset.match(/GMT([+-])(\d{2}):(\d{2})/);
        const minutes = match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '-' ? -1 : 1) : 0;
        candidate = wall - minutes * 60000;
    }
    return new Date(candidate);
}

function startOfUtcDay(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function startOfUtcMonth(date) {
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0));
}

function valueOf(point) {
    const value = point && point.value ? point.value : {};
    if (value.int64Value !== undefined) return Number(value.int64Value) || 0;
    if (value.doubleValue !== undefined) return Number(value.doubleValue) || 0;
    if (value.distributionValue && value.distributionValue.count !== undefined) {
        return Number(value.distributionValue.count) || 0;
    }
    return 0;
}

function createMonitoringUsageFetcher(options = {}) {
    const projectId = options.projectId || process.env.FIREBASE_PROJECT_ID || 'finder-owl';
    const getAccessToken = options.getAccessToken;
    const fetchImpl = options.fetchImpl || global.fetch;
    const logger = options.logger || console;
    const now = typeof options.now === 'function' ? options.now : () => new Date();

    if (typeof getAccessToken !== 'function') {
        throw new Error('createMonitoringUsageFetcher requires getAccessToken().');
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('createMonitoringUsageFetcher requires fetch (Node 18+).');
    }

    async function fetchTotal(metricType, startTime, endTime, token) {
        const params = new URLSearchParams({
            filter: `metric.type="${metricType}"`,
            'interval.startTime': startTime.toISOString(),
            'interval.endTime': endTime.toISOString(),
            'aggregation.alignmentPeriod': '60s',
            'aggregation.perSeriesAligner': 'ALIGN_SUM',
            pageSize: '1000'
        });
        let total = 0;
        let nextPageToken;
        do {
            if (nextPageToken) params.set('pageToken', nextPageToken);
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
            try {
                const response = await fetchImpl(
                    `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries?${params}`,
                    { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal }
                );
                if (!response.ok) throw new Error(`Monitoring API ${response.status} for ${metricType}`);
                const body = await response.json();
                for (const series of body.timeSeries || []) {
                    for (const point of series.points || []) total += valueOf(point);
                }
                nextPageToken = body.nextPageToken;
            } finally {
                clearTimeout(timer);
            }
        } while (nextPageToken);
        return total;
    }

    return async function fetchUsage() {
        const clock = now();
        // Ask for a slightly earlier start so late-arriving points are included.
        const dayStart = startOfPacificDay(clock);
        const monthStart = startOfUtcMonth(clock);
        const end = clock;

        const tokenResult = await getAccessToken();
        const token = typeof tokenResult === 'string' ? tokenResult : tokenResult && (tokenResult.access_token || tokenResult.accessToken);
        if (!token) throw new Error('No access token available for the Monitoring API.');

        const [reads, writes, deletes, invocations, egressBytes] = await Promise.all([
            fetchTotal(METRICS.reads, dayStart, end, token),
            fetchTotal(METRICS.writes, dayStart, end, token),
            fetchTotal(METRICS.deletes, dayStart, end, token),
            fetchTotal(METRICS.invocations, monthStart, end, token),
            fetchTotal(METRICS.egressBytes, monthStart, end, token)
        ]);

        if (logger && typeof logger.log === 'function') {
            logger.log(`[quota] Monitoring usage — reads ${reads}, writes ${writes}, deletes ${deletes}, invocations ${invocations}`);
        }

        return {
            reads,
            writes,
            deletes,
            invocations,
            egressBytes,
            source: 'monitoring',
            fetchedAt: clock.toISOString()
        };
    };
}

module.exports = { createMonitoringUsageFetcher, METRICS, startOfPacificDay, startOfUtcDay, startOfUtcMonth, valueOf };
