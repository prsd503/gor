/* Full-feature Firebase HTTP API entry point.
 * See docs/firebase-api-full-release.md. All private routes remain protected
 * by verified Firebase identity and Firestore-backed membership/society checks.
 *
 * There is deliberately NO scheduled Function. Maintenance jobs (the daily
 * notice rollover and the expired-booking cleanup) run on demand from the
 * master admin portal via POST /api/maintenance/notices and
 * POST /api/maintenance/bookings, so nothing on Cloud Run executes on a
 * timer. The same jobs still run via process cron in the MacBook fallback,
 * where ENABLE_CRON is allowed.
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
    // No route legitimately needs a minute: the slowest is a bulk import or a
    // migration, which are page-sized. A shorter ceiling caps what a stuck
    // request (and its instance time) can cost.
    timeoutSeconds: 30,
    minInstances: 0
});

// Responses are compressed by the Cloud Functions/Cloud Run front end, so no
// `compression` middleware is needed (it would only add CPU time inside the
// function). Static hosting on the MacBook fallback is handled by Express there.

// The direct Function URL strips the /api name from the path; normalize once
// so the gated Express routes work unchanged.
exports.api = onRequest({ cors: false, invoker: 'public' }, (req, res) => {
    if (!/^\/api(?:[/?]|$)/.test(req.url)) req.url = '/api' + req.url;
    return app(req, res);
});
