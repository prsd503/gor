/* Full-feature Firebase HTTP API entry point.
 * See docs/firebase-api-full-release.md. All private routes remain protected
 * by verified Firebase identity and Firestore-backed membership/society checks.
 * The notice rollover is a separate scheduled function; process cron remains disabled.
 */
'use strict';

require('dotenv').config({ path: process.env.ENV_FILE || '.env', quiet: true });
const { prepareFirebaseApi } = require('./lib/firebase-release');
const release = prepareFirebaseApi(process.env);
const { setGlobalOptions } = require('firebase-functions/v2');
const { onRequest } = require('firebase-functions/v2/https');
const app = require('./index');

setGlobalOptions({
    region: 'us-central1',
    serviceAccount: release.serviceAccount,
    maxInstances: Number(process.env.MAX_INSTANCES),
    concurrency: Number(process.env.CONCURRENCY),
    memory: '256MiB',
    timeoutSeconds: 60,
    minInstances: 0
});

// Hosting preserves /api/...; the direct Function URL strips its /api name.
// Normalize once so both transports use the same gated Express routes.
exports.api = onRequest({ cors: false, invoker: 'public' }, (req, res) => {
    if (!/^\/api(?:[/?]|$)/.test(req.url)) req.url = '/api' + req.url;
    return app(req, res);
});

// Cloud Functions do not run the long-lived server cron. Scheduler invokes this
// at midnight IST; the shared maintenance routine also respects the quota guard.
const { onSchedule } = require('firebase-functions/v2/scheduler');
exports.noticeRollover = onSchedule({ schedule: '0 0 * * *', timeZone: 'Asia/Kolkata', retryCount: 3, timeoutSeconds: 540 }, async () => {
    await app.maintenance.runNoticeRollover();
});
